#!/usr/bin/env node
// Real Linux PTY acceptance for the Rust TUI workbench batch:
// input history + @file attachments, actor queue operations, real usage/MCP rows,
// and shutdown/termios. Every byte of state lives under one disposable root.
//
// The existing `zcode-cli-rust-tui-smoke.mjs` keeps the 20-request baseline
// (13 baseline + 7 selector/compact requests); this file is the second batch and
// never reuses an old package or the user's real HOME/config/session/logs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentText } from "./lib/zcode-cli-rust-interop-fixture.mjs";
import { TUI_MODELS, prepareTuiHome } from "./lib/zcode-cli-rust-tui-fixture.mjs";
import {
  WORKBENCH_MCP_ARGUMENT,
  WORKBENCH_MCP_TOOL,
  WORKBENCH_USAGE,
  USAGE_TURN_USAGE,
  workbenchModelServer,
} from "./lib/zcode-cli-rust-workbench-model.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const binary = resolve(option("--binary", "apps/zcode-cli-rust/target/debug/zcode-cli-rust"));
const keep = args.includes("--keep");

const ALPHA = "WORKBENCH_ALPHA_MARKER_0f3a";
const BETA = "WORKBENCH_BETA_MARKER_71c5";
const GAMMA = "WORKBENCH_GAMMA_MARKER_a942";
const SCENARIOS = ["attachments", "queue", "usage", "shutdown"];
const selected = (option("--scenario", SCENARIOS.join(",")) ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of selected)
  if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario ${name}`);
if (selected.length === 0) throw new Error(`no scenario selected in ${args.join(" ")}`);
const ran = (name) => selected.includes(name);
const BASE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"];
const root = await mkdtemp(join(tmpdir(), "zcode-rust-workbench-"));
const cwd = join(root, "workspace");
const mcpStateFile = join(root, "mcp-journal.jsonl");
let model, control;
const results = {};
let success = false;

async function runScenario(name, env) {
  const input = {
    binary,
    cwd,
    env,
    root,
    scenario: name,
    controlUrl: control.url,
    mcpStateFile,
    models: TUI_MODELS,
  };
  const python = spawn("python3", [resolve("scripts/lib/zcode-cli-rust-workbench-pty.py")], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdout = [];
  python.stdout.setEncoding("utf8");
  python.stdout.on("data", (chunk) => stdout.push(chunk));
  python.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolveExit, reject) => {
    python.once("error", reject);
    python.once("close", resolveExit);
  });
  const raw = stdout.join("");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`scenario ${name} produced no JSON (exit ${code}): ${raw.slice(-2000)}`);
  }
  results[name] = parsed;
  assert.equal(
    parsed.status,
    "passed",
    `scenario ${name} failed: ${parsed.error ?? ""}\n${parsed.screen_tail ?? ""}`,
  );
  assert.equal(code, 0, `scenario ${name} exit ${code}`);
  for (const check of parsed.checks) assert.ok(check.ok, `scenario ${name}: ${check.name}`);
  return parsed;
}

/** MCP fixture 的临时 journal：真实 stdio 进程的 started/tool/closed 事件。 */
async function mcpLedger() {
  try {
    const raw = await readFile(mcpStateFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function requestTexts(requests) {
  return requests.map((request) =>
    request.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) => part.text ?? part.image_url?.url ?? "")
              .join("\n"),
      )
      .join("\n"),
  );
}

function lastUserText(request) {
  const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
  return contentText(lastUser?.content).trim();
}

try {
  await mkdir(join(cwd, "docs", "nested"), { recursive: true });
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await writeFile(join(cwd, "docs", "alpha.txt"), `${ALPHA}\n`);
  await writeFile(join(cwd, "docs", "beta.txt"), `${BETA}\n`);
  await writeFile(join(cwd, "docs", "gamma.txt"), `${GAMMA}\n`);
  await writeFile(join(cwd, "note.txt"), "WORKBENCH_NOTE_MARKER\n");
  await writeFile(
    join(cwd, ".agents", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        workbench: {
          type: "stdio",
          command: process.execPath,
          args: [resolve("scripts/ci/fixtures/mcp-workbench.mjs")],
          env: { WORKBENCH_MCP_STATE: mcpStateFile },
          timeoutMs: 20_000,
        },
      },
    }),
  );
  model = await workbenchModelServer();
  const fixtureRoot = await mkdtemp(join(root, "fixture-"));
  const home = await prepareTuiHome(fixtureRoot, model.baseUrl);
  control = await controlServer(model);
  const env = {
    ...Object.fromEntries(
      BASE_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
        key,
        process.env[key],
      ]),
    ),
    ...home,
    TERM: "xterm-256color",
    ZCODE_RUNTIME_ENV: "production",
  };

  if (ran("attachments")) await runScenario("attachments", env);
  const texts = requestTexts(model.requests);
  if (ran("attachments")) {
    const firstAlpha = texts.findIndex((text) => text.includes(ALPHA));
    assert.ok(firstAlpha >= 0, "@file attachment never reached the model");
    assert.ok(texts[firstAlpha].includes("@docs/alpha.txt"), "alpha request lost its token");
    const gammaIndex = texts.findIndex((text) => text.includes(GAMMA));
    assert.ok(gammaIndex > firstAlpha, "restored history attachment never reached the model");
    assert.ok(
      !texts.some((text) => text.includes(BETA)),
      "deleted @file placeholder attachment was still sent to the model",
    );
    // 历史恢复是草稿而不是自动提交：带附件的正文被真实提交两次（第二次验证历史去重）。
    const gammaTurns = model.requests.filter((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          contentText(message.content).trim().startsWith("draft gamma notes"),
      ),
    );
    assert.equal(gammaTurns.length, 2, "history restore should submit the restored draft twice");
  }

  let queued;
  if (ran("queue")) {
    queued = await runScenario("queue", env);
    const queueTexts = ["queue one marker", "queue three marker edited"];
    const queueOrder = queueTexts.map((text) =>
      model.requests.findIndex((request) => lastUserText(request) === text),
    );
    assert.ok(
      queueOrder.every((index) => index >= 0),
      `queued inputs never ran: ${queueOrder}`,
    );
    assert.ok(
      queueOrder[0] < queueOrder[1],
      `sendNow promotion did not run before the reordered FIFO tail: ${queueOrder}`,
    );
    assert.ok(
      !requestTexts(model.requests).some((text) => text.includes("queue two marker")),
      "deleted queue item was still executed",
    );
    assert.ok(
      requestTexts(model.requests).every((text) => !text.includes("discarded text")),
      "cancelled queue edit leaked into the model context",
    );
    const cancelTrigger = model.requests.findIndex(
      (request) => lastUserText(request) === "wb-slow second",
    );
    const cancelOne = model.requests.findIndex(
      (request) => lastUserText(request) === "cancel one marker",
    );
    const cancelTwo = model.requests.findIndex(
      (request) => lastUserText(request) === "cancel two marker",
    );
    assert.ok(
      cancelTrigger >= 0 && cancelOne > cancelTrigger && cancelTwo > cancelOne,
      `held queue did not dispatch after stop: ${[cancelTrigger, cancelOne, cancelTwo]}`,
    );
    assert.equal(queued.queue_at_stop.length, 2, "queue scenario did not finish on the held queue");
    assert.ok(queued.queue_at_stop.every((row) => row.kind === "sendText"));
  }

  let usageTurns;
  if (ran("usage")) {
    await runScenario("usage", env);
    const mcpMessages = model.requests.flatMap((request) =>
      request.messages
        .flatMap((message) => message.tool_calls ?? [])
        .filter((call) => call.function?.name === WORKBENCH_MCP_TOOL)
        .map((call) => JSON.parse(call.function.arguments)),
    );
    assert.equal(mcpMessages.length, 1, "model did not call the MCP tool exactly once");
    assert.deepEqual(mcpMessages[0], { value: WORKBENCH_MCP_ARGUMENT });
    assert.ok(
      requestTexts(model.requests).some((text) => text.includes("WORKBENCH_MCP_TOOL_RESULT")),
      "MCP tool result never came back to the model",
    );
    assert.ok(
      model.requests.some((request) =>
        (request.tools ?? []).some((tool) => tool.function?.name === WORKBENCH_MCP_TOOL),
      ),
      "MCP tool was never offered to the model",
    );
    usageTurns = ["usage turn 1", "usage turn 2", "usage turn 3"].map(
      (text) => model.requests.filter((request) => lastUserText(request) === text).length,
    );
    assert.deepEqual(usageTurns, [1, 1, 1], `usage turns were not exactly one each: ${usageTurns}`);
  }

  if (ran("shutdown")) {
    const cases = await runScenario("shutdown", env);
    assert.ok(cases.checks.some((entry) => entry.name.includes("read tickets")));
  }

  // 独立只读核对临时 DB：scope 完整 identity、去重、kind 与附件来源。
  let rows = [];
  let scopes = [];
  if (ran("attachments") || ran("queue")) {
    const database = new DatabaseSync(join(fixtureRoot, "db.sqlite"), { readOnly: true });
    try {
      rows = database
        .prepare(
          "SELECT project_id, session_id, text, attachments, kind FROM input_history ORDER BY rowid",
        )
        .all();
    } finally {
      database.close();
    }
    scopes = [...new Set(rows.map((row) => row.project_id))];
    assert.deepEqual(
      scopes,
      [resolve(cwd)],
      `input_history scope is not the workspace identity: ${scopes}`,
    );
    const textsInDb = rows.map((row) => row.text);
    const kindOf = (text) => rows.find((row) => row.text === text)?.kind;
    assert.ok(
      rows.every((row) => !row.text.startsWith("/")),
      "local slash commands must not enter input_history",
    );
    if (ran("attachments")) {
      for (const text of [
        "history one",
        "history two",
        "@docs/alpha.txt keep alpha attachment",
        "placeholder removed",
        "draft gamma notes @docs/gamma.txt",
      ]) {
        assert.equal(
          textsInDb.filter((entry) => entry === text).length,
          1,
          `accepted prompt missing or duplicated in input_history: ${text}`,
        );
      }
      assert.equal(kindOf("history one"), "prompt");
      const alphaRow = rows.find((row) => row.text.startsWith("@docs/alpha.txt keep"));
      assert.ok(alphaRow?.attachments, "alpha history row lost its attachment projection");
      assert.match(alphaRow.attachments, /docs\/alpha\.txt/);
      const gammaRow = rows.find((row) => row.text.startsWith("draft gamma notes"));
      assert.match(gammaRow.attachments, /docs\/gamma\.txt/);
      assert.equal(
        rows.filter((row) => row.attachments?.includes("docs/gamma.txt")).length,
        1,
        "history dedupe did not collapse the repeated gamma prompt",
      );
    }
    if (ran("queue")) {
      // spec：所有被接受的根 sendText（含 busy queue）都入历史；删除队列项只取消未执行，
      // 不删已接受的历史。因此被删的 queue two 仍应恰好一行，编辑不产生第二行。
      for (const text of ["queue one marker", "queue two marker", "queue three marker"]) {
        assert.equal(
          textsInDb.filter((entry) => entry === text).length,
          1,
          `accepted queued prompt missing or duplicated in input_history: ${text}`,
        );
        assert.equal(kindOf(text), "steered_input", `queued prompt kind: ${text}`);
      }
      assert.ok(
        !textsInDb.some((text) => text.includes("queue three marker edited")),
        "queue edit created a second history row",
      );
      assert.ok(
        !textsInDb.some((text) => text.includes("discarded text")),
        "cancelled queue edit entered input_history",
      );
    }
  }

  const ledger = await mcpLedger();
  const requests = model.requests.map((request, index) => ({
    index,
    lastUser: lastUserText(request),
    mcpCalls: request.messages
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.function?.name === WORKBENCH_MCP_TOOL)
      .map((call) => JSON.parse(call.function.arguments)),
  }));
  const scenarios = Object.fromEntries(
    Object.entries(results).map(([name, parsed]) => [
      name,
      {
        assertions: parsed.checks.map((entry) => entry.name),
        queue: parsed.queue,
        queueAtStop: parsed.queue_at_stop,
      },
    ]),
  );
  success = true;
  console.log(
    JSON.stringify({
      status: "passed",
      root: keep ? root : undefined,
      scenarios,
      modelRequests: requests,
      usage: { default: WORKBENCH_USAGE, turn: USAGE_TURN_USAGE },
      usageTurns,
      historyScope: scopes[0],
      history: rows.map(({ text, kind, attachments }) => ({ text, kind, attachments })),
      attachmentMarkers: { alpha: ALPHA, beta: BETA, gamma: GAMMA },
      mcpLedger: ledger,
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
      scenarios: Object.fromEntries(
        Object.entries(results).map(([name, parsed]) => [
          name,
          { checks: parsed.checks, error: parsed.error, queue: parsed.queue },
        ]),
      ),
      requestTail: model?.requests.slice(-8).map((request) => ({
        lastRole: request.messages.at(-1)?.role,
        last: contentText(request.messages.at(-1)?.content).slice(0, 200),
      })),
      requestUsers: model?.requests.map((request) => lastUserText(request)),
      requestRoles: model?.requests.map((request) =>
        request.messages.map((message) => message.role).join(","),
      ),
      mcpLedger: await mcpLedger().catch(() => []),
    }),
  );
  process.exitCode = 1;
} finally {
  if (control) await control.close();
  if (model) await model.close();
  if (success && !keep) await rm(root, { recursive: true, force: true });
  else console.error(`workbench smoke root retained: ${root}`);
}

async function controlServer(instance) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}");
    let released = false;
    try {
      instance.releaseSlow(payload.text);
      released = true;
    } catch (error) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ released, error: String(error) }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ released }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/release`,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}
