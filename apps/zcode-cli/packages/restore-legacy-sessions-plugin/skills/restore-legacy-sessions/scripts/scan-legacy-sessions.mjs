#!/usr/bin/env node
/**
 * 扫描旧 ACP 会话快照与目的地库状态。
 *
 * 用法：
 *   scan-legacy-sessions.mjs summary [--json]
 *   scan-legacy-sessions.mjs agents [--json]
 *   scan-legacy-sessions.mjs workspaces --agent <provider> [--json]
 *   scan-legacy-sessions.mjs conversations --agent <provider> --workspace <path> [--query <text>] [--limit <n>] [--json]
 *
 * 选项：
 *   --legacy-dir <path>   旧快照根目录。默认 ~/.zcodium-exp/v2/sessions
 *   --task-index <path>   任务索引 sqlite。默认 ~/.zcodium-exp/v2/tasks-index.sqlite
 *   --cli-db <path>       新 ZCode 会话 sqlite。默认 ~/.zcodium-exp/cli/db/db.sqlite
 *   --agent <provider>    按 provider 过滤，如 glm、claude、codex、opencode
 *   --workspace <path>    按 workspace 路径精确过滤
 *   --query <text>        按标题、ID 或可见正文过滤会话
 *   --conversation <id>   按 restoredTaskId / legacyTaskId / ACP session id 过滤
 *   --limit <n>           会话行数上限。默认 30
 *   --json                输出 JSON 而非 Markdown 表格
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { runScan } from "./legacy-scan.mjs";

// 技能脚本由 agent 直接以 node 执行，没有打包/依赖注入，无法 import @zcode/shared 的
// 常量，只能在这里写字面量。Bugfix：用户级数据根从 `.zcodium` 让位给 `.zcodium-exp`
// （ZCodium-project/ZCodium 的 #13/#17 要占 `~/.zcodium`），默认值必须跟着走，
// 否则扫到的是迁移后的空树。改这里的字符串时同步
// packages/shared/src/appDirNames.ts 的 ZCODE_USER_DATA_DIR_NAME。
// 基目录沿用 ZCODE_DATA_BASE_DIR，与 packages/services/src/paths.ts 的优先级一致。
const DATA_ROOT = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
const DEFAULT_LEGACY_DIR = join(DATA_ROOT, ".zcodium-exp", "v2", "sessions");
const DEFAULT_TASK_INDEX_PATH = join(DATA_ROOT, ".zcodium-exp", "v2", "tasks-index.sqlite");
const DEFAULT_CLI_DB_PATH = join(DATA_ROOT, ".zcodium-exp", "cli", "db", "db.sqlite");

const USAGE = `Usage:
  scan-legacy-sessions.mjs summary [--json]
  scan-legacy-sessions.mjs agents [--json]
  scan-legacy-sessions.mjs workspaces --agent <provider> [--json]
  scan-legacy-sessions.mjs conversations --agent <provider> --workspace <path> [--query <text>] [--limit <n>] [--json]

Options:
  --legacy-dir <path>   Legacy snapshot root. Default: ${DEFAULT_LEGACY_DIR}
  --task-index <path>   Task index sqlite path. Default: ${DEFAULT_TASK_INDEX_PATH}
  --cli-db <path>       New ZCode session sqlite path. Default: ${DEFAULT_CLI_DB_PATH}
  --agent <provider>    Filter by provider, such as glm, claude, codex, opencode.
  --workspace <path>    Filter by exact workspace path.
  --query <text>        Filter conversations by title, ids, or visible message text.
  --conversation <id>   Filter by restored task id, legacy task id, or ACP session id.
  --limit <n>           Conversation row limit. Default: 30.
  --json                Print JSON instead of Markdown tables.
`;

/** 解析参数。`--json` / `--help` 不带值，其余都必须跟一个值。 */
function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "summary",
    legacyDir: DEFAULT_LEGACY_DIR,
    taskIndexPath: DEFAULT_TASK_INDEX_PATH,
    cliDbPath: DEFAULT_CLI_DB_PATH,
    json: false,
    help: false,
    limit: 30,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") {
      args.json = true;
      continue;
    }
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for ${item}`);
    index += 1;
    if (item === "--legacy-dir") args.legacyDir = next;
    else if (item === "--task-index") args.taskIndexPath = next;
    else if (item === "--cli-db") args.cliDbPath = next;
    else if (item === "--agent") args.agent = next;
    else if (item === "--workspace") args.workspace = next;
    else if (item === "--query") args.query = next;
    else if (item === "--conversation") args.conversation = next;
    else if (item === "--limit") args.limit = Number.parseInt(next, 10);
    else throw new Error(`Unknown option: ${item}`);
  }

  // limit 解析失败或非正数时回落默认值：传个 --limit abc 不该让整轮扫描挂掉。
  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = 30;
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    runScan(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log(USAGE);
  process.exitCode = 1;
}
