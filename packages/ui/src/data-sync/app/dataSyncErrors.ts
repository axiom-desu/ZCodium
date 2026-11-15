/** 推送时设备断开：整个 push session 作废，按一次推送失败写入设备同步状态。 */
export const DATA_SYNC_OFFLINE_ERROR = "offline";
/** 写权限预检超时（与旧同步弹窗一致的 15s）。 */
export const DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR = "preflight-timeout";
/** 按行「停止」后该项的错误标记，弹窗显示为「已停止」。 */
export const DATA_SYNC_STOPPED_ERROR = "stopped";

/** 写权限预检超时。 */
export const DATA_SYNC_PREFLIGHT_TIMEOUT_MS = 15_000;

/** 旧 session 的迟到结果：一律丢弃，不能覆盖新 session 的状态。 */
export class StalePushError extends Error {}

/** 按行停止发出的取消错误。 */
export class DataSyncStoppedError extends Error {}

export function dataSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 旧 Server 缺少分类五方法 / `user-config-sync`：RPC 表现为 method-not-found
 * （agent 协议 `-32601`，或 channel 端 `Method not found: <method>`）。
 * 只识别这两条证据，其他错误仍按加载失败处理，不能当空列表成功。
 */
export function isDataSyncUnsupportedError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === -32601) return true;
  }
  return /method not found/i.test(dataSyncErrorMessage(error));
}

/** 超时包装：只用于写权限预检，其他 RPC 不加超时兜底。 */
export async function withDataSyncTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
