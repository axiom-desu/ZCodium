#!/usr/bin/env node
// Real Linux PTY acceptance for slow-ACK responsiveness (spec
// cli-rust-tui-responsive-operations). Every child, model and database lives
// under one disposable root; the driver never reads a real HOME/XDG/session DB
// or logs/. The existing 20-request baseline and 35-check workbench stay in
// their own entry points and are not replaced.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentText } from "./lib/zcode-cli-rust-interop-fixture.mjs";
import { prepareTuiHome } from "./lib/zcode-cli-rust-tui-fixture.mjs";
import { workbenchModelServer } from "./lib/zcode-cli-rust-workbench-model.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const binary = resolve(option("--binary", "apps/zcode-cli-rust/target/debug/zcode-cli-rust"));
const keep = args.includes("--keep");

// One source of truth for typed payloads: the driver sends these exact strings and
// the assertions below compare the model's recorded requests against the same values.
const texts = {
  submitFirst: "RESPONSIVE_ACK_FIRST",
  submitNext: "RESPONSIVE_NEXT_DRAFT",
  settingDraft: "RESPONSIVE_SETTING_DRAFT",
  quitDraft: "RESPONSIVE_QUIT_DRAFT",
  draftBody: "RESPONSIVE_DRAFT_BODY",
  queueSlowTurn: "wb-slow responsive queue turn",
  // 弹层正文是单行并按可视宽度截断（带省略号）；篇幅必须短于弹层内部宽度，
  // 否则续写文字会被截掉，probe 只能看到省略号而误判为“续写不可见”。
  queueEditOriginal: "RESP_QUEUE_ORIGINAL",
  queueEditFirstSave: "RESP_QUEUE_SAVE",
  queueEditContinued: "RESP_QUEUE_CONTINUE",
};
texts.queueEditCommitted = `${texts.queueEditOriginal} ${texts.queueEditFirstSave}`;
texts.queueEditExpected = `${texts.queueEditCommitted} ${texts.queueEditContinued}`;

const BASE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"];
const root = await mkdtemp(join(tmpdir(), "zcode-rust-responsive-"));
const cwd = join(root, "workspace");
let model;
let control;
let result;
let success = false;

/** Fixture-only control probe: request count + release of a real `wb-slow` stream. */
async function controlServer(instance) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ requests: instance.requests.length }));
      return;
    }
    if (request.method === "POST" && request.url === "/release") {
      let body = "";
      for await (const chunk of request) body += chunk;
      try {
        instance.releaseSlow(JSON.parse(body || "{}").text);
      } catch (error) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ released: false, error: String(error) }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ released: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

/** The business user text of a recorded request (system reminders are actor noise). */
function lastUserText(request) {
  const lastUser = [...request.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        !contentText(message.content).trimStart().startsWith("<system-reminder>"),
    );
  return contentText(lastUser?.content).trim();
}

/** Temporary HOME/XDG/DB/workspace isolation shared by one scope. */
async function prepareScope(name, baseUrl) {
  const scopeRoot = await mkdtemp(join(root, `${name}-`));
  const scopeCwd = join(scopeRoot, "workspace");
  await mkdir(join(scopeCwd, "docs"), { recursive: true });
  await writeFile(join(scopeCwd, "docs", "alpha.txt"), "RESPONSIVE_ALPHA\n");
  const home = await prepareTuiHome(await mkdtemp(join(scopeRoot, "fixture-")), baseUrl);
  const env = {
    ...Object.fromEntries(
      BASE_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
        key,
        process.env[key],
      ]),
    ),
    ...home,
    // Keep every XDG lookup inside the same disposable root as HOME/DB.
    XDG_DATA_HOME: join(home.HOME, ".local", "share"),
    XDG_STATE_HOME: join(home.HOME, ".local", "state"),
    XDG_CACHE_HOME: join(home.HOME, ".cache"),
    TERM: "xterm-256color",
    ZCODE_RUNTIME_ENV: "production",
  };
  return { cwd: scopeCwd, env, db: home.ZCODE_SESSION_DB_PATH };
}

function assertQueueDatabase(snapshot, transcript) {
  const promoted = snapshot.inputs.find((row) => row.text === texts.queueEditExpected);
  assert.ok(promoted, "edited queue body was never promoted in the temporary DB");
  assert.equal(promoted.status, "promoted", "edited queue body was not promoted");
  assert.equal(promoted.delivery, "queue", "edited item stopped being an actor queue item");
  assert.ok(promoted.promotedMessageId, "promoted queue row has no transcript message");
  const history = snapshot.history.map((row) => row.text);
  // input_history 记录 admission 时的原始提交；queue edit 只改队列项/升级出的 message part。
  assert.equal(
    history.filter((text) => text === texts.queueEditOriginal).length,
    1,
    "admission history lost the original queued body",
  );
  assert.equal(
    history.filter((text) => text === texts.queueEditExpected).length,
    0,
    "queue edit must not rewrite the admission history",
  );
  assert.equal(
    transcript.filter((text) => text === texts.queueEditExpected).length,
    1,
    "the edited body was not promoted into the transcript exactly once",
  );
  assert.equal(
    history.filter((text) => text === texts.queueSlowTurn).length,
    1,
    "the slow turn is missing from the transcript",
  );
  assert.ok(snapshot.messages >= 4, "the queue turn did not create real transcript messages");
}

try {
  await mkdir(cwd, { recursive: true });
  model = await workbenchModelServer();
  control = await controlServer(model);
  const main = await prepareScope("main", model.baseUrl);
  const queue = await prepareScope("queue", model.baseUrl);
  const python = spawn("python3", [resolve("scripts/lib/zcode-cli-rust-responsive-pty.py")], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdout = [];
  python.stdout.setEncoding("utf8");
  python.stdout.on("data", (chunk) => stdout.push(chunk));
  python.stdin.end(
    JSON.stringify({
      binary,
      root,
      controlUrl: control.url,
      prefixArgs: args.includes("--desktop") ? ["--cli"] : [],
      texts,
      cwd: main.cwd,
      env: main.env,
      db: main.db,
      // The P1 queue case owns a separate root/process so its DB assertions and the
      // old submit history never mix.
      scopes: { main, queue },
    }),
  );
  const code = await new Promise((resolveExit, reject) => {
    python.once("error", reject);
    python.once("close", resolveExit);
  });
  const raw = stdout.join("");
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`responsive PTY produced no JSON (exit ${code}): ${raw.slice(-2000)}`);
  }
  assert.equal(
    result.status,
    "passed",
    `responsive case ${result.failedCase ?? "?"} failed: ${result.error ?? ""}\n${result.screenTail ?? ""}`,
  );
  assert.equal(code, 0, `responsive PTY exit ${code}`);
  assert.ok(Array.isArray(result.checks) && result.checks.length > 0, "no checks reported");
  for (const entry of result.checks) assert.ok(entry.ok, `responsive check failed: ${entry.name}`);

  // The summary count is derived from the checks the driver actually executed.
  const checkNames = result.checks.map((entry) => entry.name);
  const requests = model.requests;
  assert.ok(requests.length > 0, "no real model requests were recorded");
  assert.deepEqual(
    requests.map(lastUserText),
    [texts.submitFirst, texts.submitNext, texts.queueSlowTurn, texts.queueEditExpected],
    "a duplicate Enter created an extra admission, a draft was lost, or a fake request was sent",
  );
  assert.deepEqual(
    result.database.history.map((row) => row.text),
    [texts.submitFirst, texts.submitNext],
    "temporary DB history does not match the two accepted drafts",
  );
  assert.ok(
    result.database.inputs.every((row) => row.status === "promoted"),
    "accepted inputs were not promoted in the temporary DB",
  );
  assertQueueDatabase(result.queueDatabase, result.queueTranscript.texts);
  assert.equal(result.coverage.realDbStartupBoot, false, "boot must not be claimed as real DB E2E");
  assert.equal(result.coverage.realDbQueueEdit, true, "queue edit case did not run");
  assert.equal(result.coverage.realDbDraft, true, "draft command case did not run");
  assert.equal(result.baseline.commit, "59ddf0bc");

  success = true;
  console.log(
    JSON.stringify({
      status: "passed",
      root: keep ? root : undefined,
      checks: checkNames,
      checkCount: checkNames.length,
      cases: result.cases,
      coverage: result.coverage,
      baseline: result.baseline,
      modelRequests: requests.map((request, index) => ({
        index,
        lastUser: lastUserText(request),
      })),
      modelRequestCount: requests.length,
      database: {
        history: result.database.history,
        inputs: result.database.inputs,
        settings: result.database.settings,
      },
      queueDatabase: {
        history: result.queueDatabase.history,
        inputs: result.queueDatabase.inputs,
      },
      queueTranscript: result.queueTranscript,
      settingRows: result.settingRows,
      unlockToReplyMs: result.unlockToReplyMs,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      root,
      keepRoot: true,
      error: String(error),
      stack: error.stack,
      checks: result?.checks,
      failedCase: result?.failedCase,
      cases: result?.cases,
      coverage: result?.coverage,
      activity: result?.activity,
      screenTail: result?.screenTail,
      requestTail: model?.requests.slice(-4).map((request) => ({
        last: lastUserText(request),
        lastRole: request.messages.at(-1)?.role,
      })),
    }),
  );
  process.exitCode = 1;
} finally {
  if (control) await control.close();
  if (model) await model.close();
  if (success && !keep) await rm(root, { recursive: true, force: true });
  else console.error(`Responsive PTY smoke root retained: ${root}`);
}
