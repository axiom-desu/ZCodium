import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildRestorePlan } from "./restore-plan.mjs";
import { buildPartDataList, messageCompletedAt } from "./restore-parts.mjs";

async function fixture(t, snapshot) {
  const root = await mkdtemp(join(tmpdir(), "zcode-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = join(root, "sessions", "workspace-hash", "legacy-task.json");
  await mkdir(join(root, "sessions", "workspace-hash"), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  return { root, snapshotPath };
}

const snapshot = {
  meta: {
    taskId: "legacy-task",
    workspacePath: "/tmp/workspace",
    provider: "claude",
    title: "Legacy title",
    model: "legacy-model",
    createdAt: 100,
    updatedAt: 200,
  },
  messages: [
    { role: "user", content: "hello", timestamp: 100 },
    {
      role: "assistant",
      content: "answer",
      thought: "reasoning",
      timestamp: 101,
      tools: [{ name: "Read", status: "completed", input: { path: "a" }, output: "ok" }],
    },
  ],
};

test("buildRestorePlan normalizes legacy metadata without touching user directories", async (t) => {
  const { snapshotPath } = await fixture(t, snapshot);
  const plan = buildRestorePlan(snapshotPath);

  assert.equal(plan.restoredTaskId, "legacy-task");
  assert.equal(plan.workspaceKey, "/tmp/workspace");
  assert.equal(plan.projectId, "proj_tmp-workspace");
  assert.equal(plan.messages.length, 2);
  assert.match(plan.metaJson, /"provider":"glm"/);
  assert.match(plan.metaJson, /"legacyTaskId":"legacy-task"/);
});

test("legacy messages become text, reasoning and tool parts", () => {
  const parts = buildPartDataList(snapshot.messages[1], "msg_legacy_1", 101);

  assert.deepEqual(
    parts.map((part) => part.type),
    ["reasoning", "text", "tool"],
  );
  assert.equal(parts[2].state.status, "completed");
  assert.equal(parts[2].state.output, "ok");
  assert.equal(messageCompletedAt(snapshot.messages[1], 101), 101);
});

test("CLI dry-run reads only the fixture snapshot and does not open the default DBs", async (t) => {
  const { snapshotPath } = await fixture(t, snapshot);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./restore-conversation.mjs", import.meta.url)),
      "--snapshot",
      snapshotPath,
      "--dry-run",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== Restoring conversation ===/);
  assert.match(result.stdout, /Title:\s+Legacy title/);
  assert.match(result.stdout, /Dry run mode: no writes performed/);
});

test("scan CLI reads only the temporary legacy root", async (t) => {
  const { root } = await fixture(t, snapshot);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./scan-legacy-sessions.mjs", import.meta.url)),
      "summary",
      "--legacy-dir",
      join(root, "sessions"),
      "--task-index",
      join(root, "missing-task-index.sqlite"),
      "--cli-db",
      join(root, "missing-cli.sqlite"),
      "--json",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.total, 1);
  assert.equal(payload.byAgent[0].key, "claude");
  assert.equal(payload.byAgent[0].count, 1);
});
