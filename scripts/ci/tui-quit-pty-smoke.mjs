import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelServer, prepareHome } from "../lib/zcode-cli-rust-interop-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "zcodium-quit-pty-"));
const keep = process.argv.includes("--keep");
let passed = false;
const model = await modelServer({ root });
try {
  for (const busy of [false, true]) {
    const directory = join(root, busy ? "busy" : "idle");
    await mkdir(directory);
    const cwd = join(directory, "workspace");
    await mkdir(cwd);
    const base = Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TMPDIR"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    const env = {
      ...base,
      ...(await prepareHome(directory, model.baseUrl)),
      TERM: "xterm-256color",
      NO_COLOR: "1",
      ZCODE_RUNTIME_ENV: "production",
      ZCODE_DATA_BASE_DIR: join(directory, "data"),
    };
    const child = spawn("python3", [resolve("scripts/lib/tui-quit-pty.py")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(
      JSON.stringify({
        root: directory,
        cwd,
        env,
        node: process.execPath,
        entry: resolve("apps/zcode-cli/packages/cli/dist/zcode.cjs"),
        busy,
      }),
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
    assert.equal(code, 0, `isolated CLI failed (${directory}): ${stdout}\n${stderr}`);
    assert.equal(JSON.parse(stdout).termios, true);
  }
  passed = true;
  console.log(
    "Built TS CLI PTY /quit passed: idle and real streaming abort, exit 0 and termios restored.",
  );
} finally {
  await model.close();
  if (passed && !keep) await rm(root, { recursive: true, force: true });
  else console.log(`TUI /quit private fixture retained: ${root}`);
}
