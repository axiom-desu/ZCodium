import type { DatabaseSync } from "node:sqlite";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import type {
  ProjectMigrationContext,
  ProjectRepositoryContract,
  ProjectTaskRef,
} from "#src/project-storage/domain/contract.js";
import type { ProjectDataRepositoryContract } from "#src/project-storage/domain/purge-contract.js";
import type { RemoteProjectRepositoryContract } from "#src/project-storage/domain/remote-project-contract.js";

/** Host 数据库的版本化迁移端口；不读取或修改 CLI db.sqlite。 */
export interface ProjectStorageContract {
  /** 加法升级后同事务交接旧版本新增行/删除/标题意图；每次启动调用，不重算已处理的 NULL。 */
  migrate(db: DatabaseSync, context: ProjectMigrationContext): Promise<MigrationResult>;
  /** 项目组织态唯一写仓储；同一实例也实现彻底删除数据的行操作（同一 Host 事务）。 */
  repository(
    db: DatabaseSync,
    hostId?: string,
  ): ProjectRepositoryContract & ProjectDataRepositoryContract;
  admitTaskIdentity(db: DatabaseSync, task: ProjectTaskRef, hostId?: string): void;
  /** 远端项目入口 intent 的唯一写仓储（与项目同库，不保存连接事实）。 */
  remoteProjects(db: DatabaseSync, hostId?: string): RemoteProjectRepositoryContract;
}
