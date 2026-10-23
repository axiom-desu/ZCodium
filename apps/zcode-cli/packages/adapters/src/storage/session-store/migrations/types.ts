import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  appVersion: string;
  id: string;
  sql: string;
  /**
   * 历史 SQL 是 checksum 输入，发布后不可修改；`apply` 只给需要幂等守卫或数据回填的迁移使用。
   * 提供 `apply` 时只执行它，`sql` 仅作为账本 checksum 与其它实现的镜像真值。
   */
  apply?: (db: DatabaseSync) => void;
}
