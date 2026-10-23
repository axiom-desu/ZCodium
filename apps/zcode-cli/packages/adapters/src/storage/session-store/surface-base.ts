import type { DatabaseSync } from "node:sqlite";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

// 单实例仍由 SqliteSessionStore 持有 connection；surface 只共享同一个 db 引用，
// 不创建第二份连接、事务或队列。
export abstract class SessionStoreSurface {
  protected constructor(
    protected readonly db: DatabaseSync,
    protected readonly dbPath: string,
  ) {}

  protected throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }
}
