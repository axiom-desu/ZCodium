import type { DatabaseSync } from "node:sqlite";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import { newRuntimeOwnerId } from "./repositories/session-deletion.js";

// 单实例仍由 SqliteSessionStore 持有 connection；surface 只共享同一个 db 引用，
// 不创建第二份连接、事务或队列。
export abstract class SessionStoreSurface {
  /** 跨进程运行态 owner：pid 用于存活判断，uuid 隔同 pid 的新连接。 */
  protected readonly runtimeOwnerId = newRuntimeOwnerId();

  protected constructor(
    protected readonly db: DatabaseSync,
    protected readonly dbPath: string,
  ) {}

  protected throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }
}
