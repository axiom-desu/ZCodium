import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  ZCODE_PROVIDER,
  optionalNumber,
  optionalString,
  removeUndefined,
  workspaceKey,
  projectIdFromPath,
} from "./restore-values.mjs";

export function buildRestorePlan(snapshotPath) {
  const raw = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const meta = raw.meta || {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];

  const legacyTaskId = String(meta.taskId || basename(snapshotPath, ".json"));
  const acpSessionId = optionalString(meta.acpSessionId) || "";
  const restoredTaskId = acpSessionId || legacyTaskId;
  const workspacePath = optionalString(meta.workspacePath) || "";
  if (!workspacePath) {
    throw new Error(`Snapshot has no workspacePath: ${snapshotPath}`);
  }

  const workspaceIdentity = optionalString(meta.workspaceIdentity) || "";
  const workspaceHash = basename(dirname(snapshotPath));
  const sourceProvider = optionalString(meta.provider) || "unknown";
  const title = optionalString(meta.title) || "Untitled session";
  const mode = optionalString(meta.mode) || "build";
  const model = optionalString(meta.model) || "";
  const traceId = optionalString(meta.traceId) || `zcode-${restoredTaskId}`;
  const createdAt = optionalNumber(meta.createdAt) ?? Date.now();
  const updatedAt = optionalNumber(meta.updatedAt) ?? createdAt;

  // 旧 ACP provider 只代表来源。恢复后的新 ZCode 任务必须按 glm 写入，否则任务列表会被过滤掉。
  const normalizedMeta = removeUndefined({
    ...meta,
    taskId: restoredTaskId,
    traceId,
    title,
    workspacePath,
    workspaceIdentity: workspaceIdentity || undefined,
    createdAt,
    updatedAt,
    mode,
    model: model || undefined,
    thoughtLevel: optionalString(meta.thoughtLevel),
    runtimeEpoch: optionalNumber(meta.runtimeEpoch),
    provider: ZCODE_PROVIDER,
    legacyTaskId,
    restoredTaskId,
    workspaceHash,
    messageCount: messages.length,
    migrationSource: undefined,
  });

  return {
    snapshotPath,
    raw,
    meta,
    messages,
    legacyTaskId,
    restoredTaskId,
    workspacePath,
    workspaceIdentity,
    workspaceHash,
    workspaceKey: workspaceKey(workspacePath, workspaceIdentity),
    projectId: projectIdFromPath(workspacePath),
    sourceProvider,
    title,
    mode,
    model,
    traceId,
    createdAt,
    updatedAt,
    searchableText: messages.map((message) => String(message.content || "")).join("\n"),
    metaJson: JSON.stringify(normalizedMeta),
  };
}

export function printPlan(plan, dryRun) {
  console.log("=== Restoring conversation ===");
  console.log(`  Title:          ${plan.title}`);
  console.log(`  SourceProvider: ${plan.sourceProvider}`);
  console.log(`  RuntimeProvider: ${ZCODE_PROVIDER}`);
  console.log(`  Model:          ${plan.model}`);
  console.log(`  Workspace:      ${plan.workspacePath}`);
  console.log(`  Messages:       ${plan.messages.length}`);
  console.log(`  restoredTaskId: ${plan.restoredTaskId}`);
  console.log(`  legacyTaskId:   ${plan.legacyTaskId}`);
  console.log(`  workspaceHash:  ${plan.workspaceHash}`);
  console.log("  migrationSource: <empty>");
  console.log(`  Dry run:        ${dryRun}`);
  console.log();
}
