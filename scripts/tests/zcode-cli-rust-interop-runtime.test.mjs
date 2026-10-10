import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRuntime } from "../zcode-cli-rust-interop-runtime.mjs";

test("an exited runtime rejects every pending RPC instead of leaving waiters hung", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-exit-test-"));
  const bundle = join(root, "exit.mjs");
  await writeFile(bundle, "process.exit(0);\n");
  const runtime = startRuntime("node", {
    bundle,
    binary: "unused",
    cwd: root,
    env: { HOME: root, USERPROFILE: root, ZCODE_STORAGE_DIR: join(root, "storage") },
    dataDir: join(root, "data"),
  });
  try {
    const first = runtime.rpc("first");
    const second = runtime.rpc("second");
    await Promise.all([
      assert.rejects(first, /exited before RPC response/),
      assert.rejects(second, /exited before RPC response/),
    ]);
  } finally {
    await runtime.kill();
    await rm(root, { recursive: true, force: true });
  }
});
