import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";
const validation = await tsImport("../../packages/shared/src/validation.ts", import.meta.url);
const selection = { providerId: "fixture", modelId: "fixture-model" };

test("Host protocol rejects retired idle messages while preserving scheduled dispatch identity", () => {
  assert.equal(
    validation.hostIncomingMessageSchema.safeParse({
      type: "off-peak-run",
      offPeakTaskId: "offpeak-old",
      workspacePath: "/fixture",
      prompt: "Old task",
      permissionMode: "build",
      modelSelection: selection,
    }).success,
    false,
  );
  for (const type of ["off-peak-run-result", "off-peak-scheduler-wake-request"]) {
    assert.equal(
      validation.hostResponseMessageSchema.safeParse({
        type,
        offPeakTaskId: "offpeak-old",
        ok: true,
      }).success,
      false,
    );
  }
  const cron = {
    type: "cron-run",
    automationId: "cron-local",
    runId: "run-local",
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    prompt: "Local task",
    modelSelection: selection,
  };
  assert.deepEqual(validation.hostIncomingMessageSchema.parse(cron), cron);
});

test("retired idle configuration RPC is absent and never consults official credentials", async () => {
  const { createCodingPlanSubscriptionService } = await tsImport(
    "../../packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
    import.meta.url,
  );
  const { ProxyChannel } = await tsImport(
    "../../packages/rpc/src/proxy-channel.ts",
    import.meta.url,
  );
  const forbidden = () => {
    throw new Error("Official network and credentials forbidden");
  };
  const service = createCodingPlanSubscriptionService({
    apiClient: { request: forbidden },
    credentialService: { load: forbidden },
    resolveOffPeakModelSelectionView: forbidden,
  });
  assert.equal("getOffPeakClientConfig" in service, false);
  assert.throws(
    () => ProxyChannel.fromService(service).call(undefined, "getOffPeakClientConfig", [{}]),
    /Method not found/,
  );
  const shared = await tsImport("../../packages/shared/src/index.ts", import.meta.url);
  assert.equal(shared.DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, "preflight-v1");
});

test("database startup preserves retired queue rows without resuming or rewriting them", async (t) => {
  const { runTasksDatabaseMigrations } = await tsImport(
    "../../packages/services/src/session/tasksDatabase/migrations.ts",
    import.meta.url,
  );
  const { prepareTasksIndexStorage } = await tsImport(
    "../../packages/services/src/session/tasksDatabase/startup.ts",
    import.meta.url,
  );
  const dir = await mkdtemp(join(tmpdir(), "zcodium-idle-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const db = new DatabaseSync(path);
  try {
    // runTasksDatabaseMigrations 是异步（含备份等异步 IO）：漏 await 会让下面的 INSERT 与迁移
    // 竞态，在表创建前就报 no such table: off_peak_tasks。OffPeak 是本仓已移除功能
    // （upstream-3.16-sync.md：保留移除决定），但既定 schema 迁移仍会创建 legacy 表并保留
    // 历史 retired 行不恢复不重写，本测试验证的正是该语义，补 await 即可。
    await runTasksDatabaseMigrations(db);
    const insert = db.prepare(
      "INSERT INTO off_peak_tasks (off_peak_task_id, prompt, permission_mode, workspace_key, workspace_path, status, queued_at, created_at, updated_at) VALUES (?, 'Historical instructions', 'build', '/fixture', '/fixture', ?, 1, 1, 1)",
    );
    for (const status of ["queued", "running", "completed", "awaiting_approval"])
      insert.run(`old-${status}`, status);
    const before = db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id").all();
    const phases = [];
    await prepareTasksIndexStorage(path, (phase) => phases.push(phase));
    assert.equal(phases.at(-1), "ready");
    assert.deepEqual(
      db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id").all(),
      before,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM automations").get().n, 0);
  } finally {
    db.close();
  }
});

test("local and remote service assembly no longer exposes idle task channels or startup hooks", async () => {
  for (const path of [
    "packages/services/src/node.ts",
    "packages/services/src/accessor.ts",
    "packages/client/src/remoteServiceAccess.ts",
    "packages/desktop/src/host/index.ts",
    "packages/desktop/src/main/index.ts",
  ]) {
    const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /IOffPeakTaskService|offPeakTaskService|OffPeakRequestAuthBuilder|onOffPeakSchedulerWakeRequested|dispatchOffPeakRun/,
    );
  }
});
