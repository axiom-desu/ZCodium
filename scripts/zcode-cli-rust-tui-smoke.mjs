#!/usr/bin/env node
// Real Linux PTY acceptance for the Rust terminal UI; all user state lives under a disposable root.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelServer, prepareHome } from "./lib/zcode-cli-rust-interop-fixture.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const binary = resolve(option("--binary", "apps/zcode-cli-rust/target/debug/zcode-cli-rust"));
const keep = args.includes("--keep");
const root = await mkdtemp(join(tmpdir(), "zcode-rust-tui-"));
let model;
let success = false;
try {
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "note.txt"), "TUI_NOTE_MARKER\n");
  model = await modelServer({ root, ignoreSystemReminders: true });
  const base = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const env = {
    ...base,
    ...(await prepareHome(root, model.baseUrl)),
    TERM: "xterm-256color",
    ZCODE_RUNTIME_ENV: "production",
  };
  if (args.includes("--provider-discovery")) {
    // 旧测试注入两个路径会掩盖裸 CLI 无法发现 GUI 配置的问题；本场景仅写 canonical 文件。
    const configRoot = join(root, "data", ".zcodium-exp", "v2");
    const builtinRoot = join(configRoot, "runtime", "provider", "bundled");
    await mkdir(builtinRoot, { recursive: true });
    if (!args.includes("--packaged-builtin")) {
      await copyFile(
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
        join(builtinRoot, "zcode-builtin.json"),
      );
    }
    await copyFile(
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
      join(configRoot, "provider_config.json"),
    );
    env.ZCODE_DATA_BASE_DIR = join(root, "data");
    delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    assert.equal(env.ZCODE_AGENT_SERVER_RUNTIME, undefined);
  }
  const python = spawn("python3", [resolve("scripts/lib/zcode-cli-rust-tui-pty.py")], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdout = [];
  python.stdout.setEncoding("utf8");
  python.stdout.on("data", (chunk) => stdout.push(chunk));
  python.stdin.end(
    JSON.stringify({
      binary,
      cwd,
      env,
      root,
      prefixArgs: args.includes("--desktop") ? ["--cli"] : [],
    }),
  );
  const code = await new Promise((resolveExit, reject) => {
    python.once("error", reject);
    python.once("close", resolveExit);
  });
  const result = JSON.parse(stdout.join(""));
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, "passed", JSON.stringify(result));
  const last = model.requests.at(-1);
  assert.ok(
    last.messages.some((m) => typeof m.content === "string" && m.content.includes("first turn")),
    "continued session lost its prior model context",
  );
  assert.ok(result.sessionId, "missing real session id from /sessions");
  const requests = model.requests;
  const allText = requests
    .flatMap((request) =>
      request.messages.map((message) => {
        const content = message.content;
        return typeof content === "string"
          ? content
          : (content ?? []).map((part) => part.text ?? "").join("");
      }),
    )
    .join("\n");
  for (const prompt of [
    "first turn",
    "second distinct turn",
    "use tool",
    "tui-write-deny",
    "tui-write-allow",
    "tui-question",
    "slow request",
    "after cancellation",
    "continue history check",
  ])
    assert.ok(allText.includes(prompt), `local model did not receive prompt: ${prompt}`);
  const toolNames = requests.flatMap((request) =>
    request.messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name),
  );
  for (const name of ["Read", "Write", "AskUserQuestion"])
    assert.ok(toolNames.includes(name), `model did not issue real ${name} tool call`);
  assert.equal(await readFile(join(cwd, "allowed.txt"), "utf8"), "TUI_WRITE_MARKER\n");
  assert.equal(
    await readFile(join(cwd, "denied.txt"), "utf8").then(
      () => true,
      () => false,
    ),
    false,
  );
  success = true;
  console.log(
    JSON.stringify({
      status: "passed",
      root: keep ? root : undefined,
      providerDiscovery: args.includes("--provider-discovery"),
      packagedBuiltin: args.includes("--packaged-builtin"),
      assertions: result.assertions,
      sessionId: result.sessionId,
      modelRequests: requests.length,
      tools: toolNames,
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
    }),
  );
  process.exitCode = 1;
} finally {
  if (model) await model.close();
  if (success && !keep) await rm(root, { recursive: true, force: true });
  else console.error(`TUI smoke root retained: ${root}`);
}
