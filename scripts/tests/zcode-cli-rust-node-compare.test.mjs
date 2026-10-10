import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts";

const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const createEmptyDatabase = (path) => {
  const db = new DatabaseSync(path);
  db.close();
};

test("startup migrations on an independent copy preserve source; direct startup is a write control", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-compare-isolation-test-"));
  try {
    const source = join(root, "source.sqlite");
    const copy = join(root, "copy.sqlite");
    const negative = join(root, "negative.sqlite");
    createEmptyDatabase(source);
    createEmptyDatabase(negative);
    const sourceBefore = await hash(source);
    await copyFile(source, copy);
    const store = await SqliteSessionStore.openStartup({ dbPath: copy });
    store.close();
    assert.equal(await hash(source), sourceBefore, "Node reader mutated the original source");
    assert.notEqual(
      await hash(copy),
      sourceBefore,
      "positive control did not exercise startup migration writes",
    );

    const negativeBefore = await hash(negative);
    const negativeStore = await SqliteSessionStore.openStartup({ dbPath: negative });
    negativeStore.close();
    assert.notEqual(
      await hash(negative),
      negativeBefore,
      "negative control did not demonstrate migration writes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
