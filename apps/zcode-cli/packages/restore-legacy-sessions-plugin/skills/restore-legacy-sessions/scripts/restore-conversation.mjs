#!/usr/bin/env node
/**
 * Restore a single legacy ACP-era conversation snapshot into the new ZCode stores.
 *
 * Usage:
 *   restore-conversation.mjs --snapshot <path> [--task-index <path>] [--cli-db <path>]
 *
 * Options:
 *   --snapshot <path>   Path to the legacy snapshot JSON file (required)
 *   --task-index <path> Task index sqlite path. Default: ~/.zcode/v2/tasks-index.sqlite
 *   --cli-db <path>     New ZCode session sqlite path. Default: ~/.zcode/cli/db/db.sqlite
 *   --dry-run           Print what would be done without writing
 */

import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ZCODE_PROVIDER,
  optionalNumber,
  optionalString,
  removeUndefined,
} from "./restore-values.mjs";
import { buildRestorePlan, printPlan } from "./restore-plan.mjs";
import { buildPartDataList, messageCompletedAt } from "./restore-parts.mjs";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function filterSqliteExperimentalWarning(warning, ...args) {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmitWarning;

// 目录分工（不要合并成同一个根）：
// - 源：`~/.zcode/v2/sessions` —— ACP 时代的 ZCode 数据，是上游那代的用户级数据根，
//   本仓库不改写它，只读。
// - 目标：`~/.zcodium-exp/{v2,cli}` —— 本仓库自己的用户级数据根
//   （packages/shared/src/appDirNames.ts 的 ZCODE_USER_DATA_DIR_NAME）。
// 两个根不同名是刻意的：改名是为了与上游/其它 fork 隔离，不是迁移。
const defaultTaskIndexPath = join(homedir(), ".zcodium-exp", "v2", "tasks-index.sqlite");
const defaultCliDbPath = join(homedir(), ".zcodium-exp", "cli", "db", "db.sqlite");
function parseArgs(argv) {
  const args = {
    snapshot: null,
    taskIndexPath: defaultTaskIndexPath,
    cliDbPath: defaultCliDbPath,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    const next = argv[++i];
    if (!next) throw new Error(`Missing value for ${item}`);
    if (item === "--snapshot") args.snapshot = next;
    else if (item === "--task-index") args.taskIndexPath = next;
    else if (item === "--cli-db") args.cliDbPath = next;
    else throw new Error(`Unknown option: ${item}`);
  }

  if (!args.snapshot) throw new Error("--snapshot is required");
  if (!existsSync(args.snapshot)) throw new Error(`Snapshot not found: ${args.snapshot}`);
  return args;
}

function ensureExistingDb(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} is not a populated sqlite file: ${path}`);
  }
}

function backupDb(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-${stamp}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function writeTaskIndex(taskDb, plan) {
  const upsertTask = taskDb.prepare(`
    INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, title,
       task_status, provider, mode, model, migration_source, forked_from_task_id,
       created_at, updated_at, unread_at, meta_json, searchable_text)
    VALUES
      (@workspace_key, @workspace_path, @workspace_identity, @task_id, @title,
       @task_status, @provider, @mode, @model, NULL, @forked_from_task_id,
       @created_at, @updated_at, @unread_at, @meta_json, @searchable_text)
    ON CONFLICT(workspace_key, task_id) DO UPDATE SET
      workspace_path = excluded.workspace_path,
      workspace_identity = excluded.workspace_identity,
      title = CASE
        WHEN tasks.title_overridden = 1 THEN tasks.title
        ELSE excluded.title
      END,
      task_status = excluded.task_status,
      provider = excluded.provider,
      mode = excluded.mode,
      model = excluded.model,
      migration_source = NULL,
      forked_from_task_id = excluded.forked_from_task_id,
      created_at = MIN(tasks.created_at, excluded.created_at),
      updated_at = MAX(tasks.updated_at, excluded.updated_at),
      unread_at = tasks.unread_at,
      searchable_text = CASE
        WHEN tasks.updated_at > excluded.updated_at THEN tasks.searchable_text
        ELSE excluded.searchable_text
      END,
      meta_json = excluded.meta_json
  `);

  upsertTask.run({
    workspace_key: plan.workspaceKey,
    workspace_path: plan.workspacePath,
    workspace_identity: plan.workspaceIdentity || null,
    task_id: plan.restoredTaskId,
    title: plan.title,
    task_status: optionalString(plan.meta.status) || null,
    provider: ZCODE_PROVIDER,
    mode: plan.mode,
    model: plan.model || null,
    forked_from_task_id: optionalString(plan.meta.forkedFromTaskId) || null,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    unread_at: optionalNumber(plan.meta.unreadAt) ?? null,
    meta_json: plan.metaJson,
    searchable_text: plan.searchableText,
  });
}

function writeSession(cliDb, plan) {
  const upsertSession = cliDb.prepare(`
    INSERT INTO session
      (id, project_id, workspace_id, slug, directory, path, title, version,
       time_created, time_updated, task_type, title_source, trace_id)
    VALUES
      (@id, @project_id, @workspace_id, @slug, @directory, @path, @title, @version,
       @time_created, @time_updated, @task_type, @title_source, @trace_id)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      workspace_id = excluded.workspace_id,
      slug = excluded.slug,
      directory = excluded.directory,
      path = excluded.path,
      title = CASE
        WHEN session.title_source = 'custom' THEN session.title
        ELSE excluded.title
      END,
      version = excluded.version,
      time_created = MIN(session.time_created, excluded.time_created),
      time_updated = MAX(session.time_updated, excluded.time_updated),
      task_type = excluded.task_type,
      trace_id = COALESCE(session.trace_id, excluded.trace_id)
  `);

  upsertSession.run({
    id: plan.restoredTaskId,
    project_id: plan.projectId,
    workspace_id: plan.workspaceHash,
    slug: plan.restoredTaskId,
    directory: plan.workspacePath,
    path: plan.workspacePath,
    title: plan.title,
    version: "0.14.5",
    time_created: plan.createdAt,
    time_updated: plan.updatedAt,
    task_type: "interactive",
    title_source: "first_input",
    trace_id: plan.traceId,
  });
}

function writeMessages(cliDb, plan) {
  const insertMessage = cliDb.prepare(`
    INSERT OR REPLACE INTO message
      (id, session_id, time_created, time_updated, data)
    VALUES
      (@id, @session_id, @time_created, @time_updated, @data)
  `);
  const insertPart = cliDb.prepare(`
    INSERT OR REPLACE INTO part
      (id, message_id, session_id, time_created, time_updated, data)
    VALUES
      (@id, @message_id, @session_id, @time_created, @time_updated, @data)
  `);
  const deleteLegacyParts = cliDb.prepare(`
    DELETE FROM part
    WHERE session_id = @session_id AND id LIKE @id_prefix
  `);

  let partCount = 0;
  let latestUserMessageId = "";
  deleteLegacyParts.run({
    session_id: plan.restoredTaskId,
    id_prefix: `part_legacy_${plan.restoredTaskId}_%`,
  });
  for (const [index, message] of plan.messages.entries()) {
    const messageTimestamp = optionalNumber(message.timestamp) ?? plan.updatedAt;
    const completedAt = messageCompletedAt(message, messageTimestamp);
    const messageId = `msg_legacy_${plan.restoredTaskId}_${index}`;
    const role = message.role === "assistant" ? "assistant" : "user";
    const baseMessageData = {
      role,
      time: removeUndefined({
        created: messageTimestamp,
        completed: role === "assistant" ? completedAt : undefined,
      }),
      agent: "zcode-agent",
    };
    // Bugfix: 恢复脚本必须写当前消息契约；继续生成旧消息身份字段会迫使正常读取链依赖 legacy codec，
    // 并让新恢复的数据再次成为待迁移数据。
    const messageData =
      role === "assistant"
        ? {
            ...baseMessageData,
            content: message.content,
            modelId: message.model || plan.model || "unknown",
            providerId: ZCODE_PROVIDER,
            mode: plan.mode,
            path: {
              cwd: plan.workspacePath,
              root: plan.workspacePath,
            },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: "stop",
            ...(latestUserMessageId ? { parentID: latestUserMessageId } : {}),
            ...(Array.isArray(message.tools) && message.tools.length > 0
              ? {
                  toolCalls: message.tools.map((tool, toolIndex) => ({
                    id: `tool_${messageId}_${toolIndex}`,
                    toolName: tool.title || "",
                    kind: tool.kind || "other",
                    status: tool.status || "completed",
                    input: tool.input || {},
                    output: tool.output || "",
                    ...(tool.raw ? { raw: tool.raw } : {}),
                  })),
                }
              : {}),
            ...(message.characterCount !== undefined
              ? { characterCount: message.characterCount }
              : {}),
            ...(message.turnIndex !== undefined ? { turnIndex: message.turnIndex } : {}),
          }
        : {
            ...baseMessageData,
            content: message.content,
            modelSelection: {
              providerId: ZCODE_PROVIDER,
              modelId: message.model || plan.model || "unknown",
            },
            // 旧 Reader 无条件访问 User.model；显式导入绕过普通 Writer，也必须补最小对象防止回滚打不开正文。
            // 不复制模型身份：当前选择只有 modelSelection，旧版允许模型失效但不能读取抛错。
            model: {},
            ...(message.characterCount !== undefined
              ? { characterCount: message.characterCount }
              : {}),
            ...(message.turnIndex !== undefined ? { turnIndex: message.turnIndex } : {}),
          };

    insertMessage.run({
      id: messageId,
      session_id: plan.restoredTaskId,
      time_created: messageTimestamp,
      time_updated: messageTimestamp,
      data: JSON.stringify(removeUndefined(messageData)),
    });

    // Bugfix: 详情页从 part 表还原可见正文；只有 message.data.content 会出现任务可打开但历史区空白。
    const partDataList = buildPartDataList(message, messageId, messageTimestamp);
    for (const [partIndex, partData] of partDataList.entries()) {
      const partTimestamp = messageTimestamp + partIndex;
      insertPart.run({
        id: `part_legacy_${plan.restoredTaskId}_${String(index).padStart(4, "0")}_${String(
          partIndex,
        ).padStart(4, "0")}`,
        message_id: messageId,
        session_id: plan.restoredTaskId,
        time_created: partTimestamp,
        time_updated: partTimestamp,
        data: JSON.stringify(partData),
      });
      partCount++;
    }

    if (role === "user") {
      latestUserMessageId = messageId;
    }
  }
  return { messageCount: plan.messages.length, partCount };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildRestorePlan(args.snapshot);
  printPlan(plan, args.dryRun);

  if (args.dryRun) {
    console.log("Dry run mode: no writes performed.");
    return;
  }

  ensureExistingDb(args.taskIndexPath, "Task index");
  ensureExistingDb(args.cliDbPath, "CLI DB");
  const taskBackupPath = backupDb(args.taskIndexPath);
  const cliBackupPath = backupDb(args.cliDbPath);
  console.log(`Backed up task index: ${taskBackupPath}`);
  console.log(`Backed up CLI DB:     ${cliBackupPath}`);

  const taskDb = new DatabaseSync(args.taskIndexPath);
  const cliDb = new DatabaseSync(args.cliDbPath);
  let taskInTx = false;
  let cliInTx = false;

  try {
    taskDb.exec("BEGIN IMMEDIATE");
    taskInTx = true;
    cliDb.exec("BEGIN IMMEDIATE");
    cliInTx = true;

    console.log("[1/2] Writing task index...");
    writeTaskIndex(taskDb, plan);
    console.log(`  tasks row ready: ${plan.restoredTaskId}`);

    console.log("[2/2] Writing CLI session DB...");
    writeSession(cliDb, plan);
    const writeResult = writeMessages(cliDb, plan);
    console.log(`  message rows ready: ${writeResult.messageCount}`);
    console.log(`  part rows ready:    ${writeResult.partCount}`);

    taskDb.exec("COMMIT");
    taskInTx = false;
    cliDb.exec("COMMIT");
    cliInTx = false;

    console.log();
    console.log("=== Restore complete ===");
  } catch (error) {
    if (taskInTx) {
      try {
        taskDb.exec("ROLLBACK");
      } catch {}
    }
    if (cliInTx) {
      try {
        cliDb.exec("ROLLBACK");
      } catch {}
    }
    console.error("Restore failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    taskDb.close();
    cliDb.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
