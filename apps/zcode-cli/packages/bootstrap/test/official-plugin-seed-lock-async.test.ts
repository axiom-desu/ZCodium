import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withOfficialPluginSeedLock } from "../src/app/official-plugin-seed-lock.js";

test("seed lock remains owned until asynchronous validation and promotion finish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-seed-lock-async-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "plugin");
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((accept) => {
    enter = accept;
  });
  const pending = new Promise<void>((accept) => {
    finish = accept;
  });
  const action = withOfficialPluginSeedLock(target, async () => {
    enter();
    await pending;
    const owner = JSON.parse(await readFile(`${target}.seed-lock/owner.json`, "utf8"));
    assert.equal(owner.pid, process.pid);
    return "promoted";
  });
  await entered;
  try {
    await stat(`${target}.seed-lock`);
  } finally {
    finish();
  }
  assert.equal(await action, "promoted");
  await assert.rejects(stat(`${target}.seed-lock`), { code: "ENOENT" });
  await assert.rejects(
    withOfficialPluginSeedLock(target, async () => {
      throw new Error("validation failed");
    }),
    /validation failed/u,
  );
  await assert.rejects(stat(`${target}.seed-lock`), { code: "ENOENT" });
});
