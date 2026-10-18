import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "tui-quit-smoke.mjs");
test("TUI /quit uses the real renderer keyboard and lifecycle", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
});
