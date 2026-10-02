#!/usr/bin/env node
/**
 * 把一条旧 ACP 会话快照恢复进新的 ZCode 库。
 *
 * 用法：
 *   restore-conversation.mjs --snapshot <path> [--task-index <path>] [--cli-db <path>]
 *
 * 选项：
 *   --snapshot <path>   旧快照 JSON 路径（必填）
 *   --task-index <path> 任务索引 sqlite。默认 ~/.zcodium-exp/v2/tasks-index.sqlite
 *   --cli-db <path>     新 ZCode 会话 sqlite。默认 ~/.zcodium-exp/cli/db/db.sqlite
 *   --dry-run           只打印将要做什么，不写库
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { asNumber, asText, compact } from "./legacy-values.mjs";
import {
  RESTORED_PROVIDER,
  normalizeRestoreMeta,
  projectIdFor,
  readLegacySnapshot,
  restoreTitleOf,
  workspaceKeyOf,
} from "./legacy-snapshot.mjs";
import { backupDb, ensurePopulatedDb, writeRestore } from "./legacy-store.mjs";
import { openWritable } from "./legacy-sqlite.mjs";

// 与 scan-legacy-sessions.mjs 同因：agent 直接执行的独立脚本，无法 import 常量，
// 只能写字面量；用户级数据根已从 `.zcodium` 让位给 `.zcodium-exp`，默认值必须跟着走。
// 改这里时同步 packages/shared/src/appDirNames.ts 的 ZCODE_USER_DATA_DIR_NAME。
const DATA_ROOT = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
const DEFAULT_TASK_INDEX_PATH = join(DATA_ROOT, ".zcodium-exp", "v2", "tasks-index.sqlite");
const DEFAULT_CLI_DB_PATH = join(DATA_ROOT, ".zcodium-exp", "cli", "db", "db.sqlite");

function parseArgs(argv) {
  const args = {
    snapshot: null,
    taskIndexPath: DEFAULT_TASK_INDEX_PATH,
    cliDbPath: DEFAULT_CLI_DB_PATH,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for ${item}`);
    index += 1;
    if (item === "--snapshot") args.snapshot = next;
    else if (item === "--task-index") args.taskIndexPath = next;
    else if (item === "--cli-db") args.cliDbPath = next;
    else throw new Error(`Unknown option: ${item}`);
  }

  if (!args.snapshot) throw new Error("--snapshot is required");
  return args;
}

/**
 * 从快照构建恢复计划。
 *
 * 纯函数：不碰库、不写文件。dry-run 与实跑走同一个计划，保证「打印的」就是「要写的」。
 */
function buildPlan(snapshotPath) {
  const snapshot = readLegacySnapshot(snapshotPath);
  if (snapshot.error) throw new Error(snapshot.error);
  if (!snapshot.workspacePath) {
    throw new Error(`Snapshot has no workspacePath: ${snapshotPath}`);
  }

  const meta = snapshot.meta;
  const title = restoreTitleOf(snapshot);
  const createdAt = asNumber(meta.createdAt) ?? Date.now();
  const updatedAt = asNumber(meta.updatedAt) ?? createdAt;
  const metaJson = JSON.stringify(
    compact(normalizeRestoreMeta({ ...snapshot, title, createdAt, updatedAt })),
  );

  return {
    snapshot,
    title,
    mode: asText(meta.mode) || "build",
    model: asText(meta.model) || "",
    traceId: asText(meta.traceId) || `zcode-${snapshot.restoredTaskId}`,
    createdAt,
    updatedAt,
    workspacePath: snapshot.workspacePath,
    workspaceIdentity: snapshot.workspaceIdentity,
    workspaceKey: workspaceKeyOf(snapshot.workspacePath, snapshot.workspaceIdentity),
    projectId: projectIdFor(snapshot.workspacePath),
    sourceProvider: snapshot.provider,
    restoredTaskId: snapshot.restoredTaskId,
    legacyTaskId: snapshot.legacyTaskId,
    workspaceHash: snapshot.workspaceHash,
    searchableText: snapshot.visibleText,
    metaJson,
    meta,
  };
}

function printPlan(plan, dryRun) {
  // 对齐保持与参考实现逐字一致：这里改一个空格就会让「输出没变」的断言失效，
  // 而那个断言是回归测试唯一能抓差异的地方。想改善对齐请单独提交。
  console.log("=== Restoring conversation ===");
  console.log(`  Title:          ${plan.title}`);
  console.log(`  SourceProvider: ${plan.sourceProvider}`);
  console.log(`  RuntimeProvider: ${RESTORED_PROVIDER}`);
  console.log(`  Model:          ${plan.model}`);
  console.log(`  Workspace:      ${plan.workspacePath}`);
  console.log(`  Messages:       ${plan.snapshot.messageCount}`);
  console.log(`  restoredTaskId: ${plan.restoredTaskId}`);
  console.log(`  legacyTaskId:   ${plan.legacyTaskId}`);
  console.log(`  workspaceHash:  ${plan.workspaceHash}`);
  console.log("  migrationSource: <empty>");
  console.log(`  Dry run:        ${dryRun}`);
  console.log();
}

/** 打开 node:sqlite。实验性告警的屏蔽在 legacy-sqlite.mjs 里，只包住 import。 */
function openDatabase(path) {
  return openWritable(path);
}

/**
 * 两个库的事务边界。
 *
 * 各自 BEGIN IMMEDIATE / COMMIT，任一失败两边都 ROLLBACK。任务索引和会话库必须同时
 * 成功：只写一边会留下「任务列表有、打开是空的」或反过来的一半状态，而那比不恢复
 * 更难排查。
 */
async function applyRestore(args, plan) {
  ensurePopulatedDb(args.taskIndexPath, "Task index");
  ensurePopulatedDb(args.cliDbPath, "CLI DB");
  const taskBackup = backupDb(args.taskIndexPath);
  const cliBackup = backupDb(args.cliDbPath);
  console.log(`Backed up task index: ${taskBackup}`);
  console.log(`Backed up CLI DB:     ${cliBackup}`);

  const taskDb = openDatabase(args.taskIndexPath);
  const cliDb = openDatabase(args.cliDbPath);
  let taskInTx = false;
  let cliInTx = false;

  try {
    taskDb.exec("BEGIN IMMEDIATE");
    taskInTx = true;
    cliDb.exec("BEGIN IMMEDIATE");
    cliInTx = true;

    writeRestore(taskDb, cliDb, plan, (line) => console.log(line));

    taskDb.exec("COMMIT");
    taskInTx = false;
    cliDb.exec("COMMIT");
    cliInTx = false;

    console.log();
    console.log("=== Restore complete ===");
  } catch (error) {
    // 回滚失败不能吞掉原始错误：用户需要知道是哪儿断的。
    for (const [db, inTx] of [
      [taskDb, taskInTx],
      [cliDb, cliInTx],
    ]) {
      if (!inTx) continue;
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error(`Rollback failed: ${String(rollbackError)}`);
      }
    }
    console.error("Restore failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    taskDb.close();
    cliDb.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args.snapshot);
  printPlan(plan, args.dryRun);
  if (args.dryRun) {
    console.log("Dry run mode: no writes performed.");
    return;
  }
  await applyRestore(args, plan);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
