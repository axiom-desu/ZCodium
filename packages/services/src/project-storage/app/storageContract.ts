import type { DatabaseSync } from "node:sqlite";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import type {
  ProjectMigrationContext,
  ProjectRepositoryContract,
  ProjectTaskRef,
} from "#src/project-storage/domain/contract.js";

/** Host 数据库的版本化迁移端口；不读取或修改 CLI db.sqlite。 */
export interface ProjectStorageContract {
  /** 加法升级后同事务交接旧版本新增行/删除/标题意图；每次启动调用，不重算已处理的 NULL。 */
  migrate(db: DatabaseSync, context: ProjectMigrationContext): Promise<MigrationResult>;
  repository(db: DatabaseSync, hostId?: string): ProjectRepositoryContract;
  admitTaskIdentity(db: DatabaseSync, task: ProjectTaskRef, hostId?: string): void;
}
