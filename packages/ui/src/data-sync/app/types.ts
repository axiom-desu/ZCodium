import type {
  DataSyncCategoryId,
  DataSyncCategoryPhase,
  DataSyncUnsupportedReason,
} from "../contract.js";
import type { DataSyncRow } from "../domain/compareRows.js";

export type DataSyncPushState = "idle" | "pushing" | "done" | "failed";
export type DataSyncPushAllState = "idle" | "pushing" | "done";

export interface DataSyncItemError {
  status: "failed" | "conflict";
  message?: string;
}

/** 分类页面状态；`phase` 由 `useDataSyncDialog` 唯一写入。 */
export interface DataSyncCategoryView {
  id: DataSyncCategoryId;
  phase: DataSyncCategoryPhase;
  error?: string;
  /** phase === "unsupported" 时的固定原因（旧 Server 缺方法）。 */
  unsupportedReason?: DataSyncUnsupportedReason;
  rows: DataSyncRow[];
  localCount: number;
  remoteCount: number;
  /** 最近一次加载的两端条目 key（含各端独有项），供其他分类的依赖提示使用；只在 phase 为 ready 时有效。 */
  sourceKeys: ReadonlySet<string>;
  targetKeys: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  push: DataSyncPushState;
  /** 分类整体失败（预检、RPC、断线）的原因；`offline` 表示推送中设备断开。 */
  pushError?: string;
  itemErrors: Readonly<Record<string, DataSyncItemError>>;
  failedCount: number;
  /** 推送中当前可「停止」的项（marketplace 插件的目标端 add / install 阶段）。 */
  stoppable: ReadonlySet<string>;
}

export interface DataSyncPushOutcome {
  succeeded: number;
  failed: number;
}
