import { BASE_SCHEMA_MIGRATIONS } from "./migrations/0001-0006-base-schema.js";
import { WORKFLOW_SCHEMA_MIGRATIONS } from "./migrations/0007-0009-workflow-schema.js";
import { USAGE_SCHEMA_MIGRATIONS } from "./migrations/0010-0012-usage-schema.js";
import { MESSAGE_SEQUENCE_MIGRATIONS } from "./migrations/0013-0015-message-sequences.js";
import { SESSION_INPUT_MIGRATIONS } from "./migrations/0016-0018-session-inputs.js";
import { DWF_JOURNAL_MIGRATIONS } from "./migrations/0019-dwf-journal.js";
import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./migrations/0020-provider-model-selection.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./migrations/0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./migrations/0022-backfilled-session-reasoning.js";
import { SESSION_SOFT_DELETE_OUTCOME_MIGRATION } from "./migrations/0023-session-soft-delete-outcome.js";
import type { SqliteMigration } from "./migrations/types.js";

// 拆分只移动对象字面量；各组按既有 id 顺序静态拼接，SQL 字节由 lock test 与 Rust
// node/migrations/*.sql 逐字节锁定。新增迁移只能追加到末尾。
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  ...BASE_SCHEMA_MIGRATIONS,
  ...WORKFLOW_SCHEMA_MIGRATIONS,
  ...USAGE_SCHEMA_MIGRATIONS,
  ...MESSAGE_SEQUENCE_MIGRATIONS,
  ...SESSION_INPUT_MIGRATIONS,
  ...DWF_JOURNAL_MIGRATIONS,
  {
    appVersion: "0.16.5",
    id: "0020_provider_model_selection",
    sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL,
  },
  {
    appVersion: "0.16.5",
    id: "0021_official_glm_selection",
    sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL,
  },
  {
    appVersion: "0.16.5",
    id: "0022_backfilled_session_reasoning",
    sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL,
  },
  SESSION_SOFT_DELETE_OUTCOME_MIGRATION,
];
