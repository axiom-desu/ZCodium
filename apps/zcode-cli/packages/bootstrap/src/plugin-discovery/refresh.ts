const REFRESH_INTERVAL_MS = 10 * 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

interface Flight {
  promise: Promise<{ stale: boolean }>;
  controller: AbortController;
  readers: number;
}

interface Entry {
  attemptedAt: number;
  stale: boolean;
  flight?: Flight;
}

/**
 * 官方插件目录刷新的单飞所有者。
 *
 * 插件存储根持有刷新事实；这里不做跨端权威，也不保存候选——离开进程就丢弃。
 * 并发搜索/安装确认共享同一次 flight；调用方取消只摘除自己的读者，最后一个读者取消才
 * 中止刷新。失去读者的旧 flight 结束时不得发布结果或节流时间（否则紧随其后的确认会
 * 复用已取消的刷新，读到空目录）。
 */
export class OfficialPluginCatalogRefresh {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  async ensure(
    key: string,
    lastUpdated: string | undefined,
    update: (signal: AbortSignal) => Promise<void>,
    options: { force: boolean; signal: AbortSignal },
  ): Promise<{ stale: boolean }> {
    options.signal.throwIfAborted();
    let entry = this.entries.get(key);
    const updatedAt = lastUpdated ? Date.parse(lastUpdated) : NaN;
    if (!entry) {
      entry = { attemptedAt: -Infinity, stale: !Number.isFinite(updatedAt) };
      this.entries.set(key, entry);
    }
    if (
      !entry.flight &&
      !options.force &&
      this.now() - Math.max(entry.attemptedAt, Number.isFinite(updatedAt) ? updatedAt : -Infinity) <
        REFRESH_INTERVAL_MS
    ) {
      return {
        stale: Number.isFinite(updatedAt) && updatedAt > entry.attemptedAt ? false : entry.stale,
      };
    }
    if (!entry.flight) {
      const attemptedAt = this.now();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
      const owner = entry;
      const flight: Flight = { controller, readers: 0, promise: Promise.resolve({ stale: true }) };
      flight.promise = Promise.resolve()
        .then(() => update(signal))
        .then(
          () => ({ stale: false }),
          () => ({ stale: true }),
        )
        .then((result) => {
          // 失去读者的旧刷新可能最后才结束；只有当前刷新可以发布结果和节流时间。
          if (owner.flight === flight) {
            owner.stale = result.stale;
            owner.attemptedAt = attemptedAt;
            owner.flight = undefined;
          }
          return result;
        });
      entry.flight = flight;
    }
    const flight = entry.flight;
    flight.readers += 1;
    return new Promise<{ stale: boolean }>((resolve, reject) => {
      const abort = () => {
        // 与调用方的取消同步摘除，避免紧接着的确认请求复用已经取消的刷新。
        if (--flight.readers === 0 && entry.flight === flight) {
          entry.flight = undefined;
          flight.controller.abort();
        }
        reject(options.signal.reason ?? new Error("Plugin catalog refresh cancelled"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      void flight.promise
        .then(resolve, reject)
        .finally(() => options.signal.removeEventListener("abort", abort));
    });
  }
}

/**
 * 进程内单例：同一 CLI/Host 的所有会话共用一次刷新预算。
 * 测试可注入独立实例（`new OfficialPluginCatalogRefresh(now)`）。
 */
export const officialPluginCatalogRefresh = new OfficialPluginCatalogRefresh();
