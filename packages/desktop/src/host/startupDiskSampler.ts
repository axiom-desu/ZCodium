import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { StartupDiskSummary } from "@zcode/shared";

const SAMPLE_INTERVAL_MS = 2000;
type Probe = (path: string) => Promise<{ scope: string; availableBytes: number }>;
type Scope = StartupDiskSummary & { path: string; baseline: number | null };

/** 仅查询已知目录元数据；dev 只在首次解析时读取，周期内只做 statfs。 */
function createProbe(): Probe {
  const resolved = new Map<string, { path: string; scope: string }>();
  return async (path) => {
    let location = resolved.get(path);
    if (!location) {
      let parent = dirname(path);
      for (;;) {
        try {
          const info = await stat(parent, { bigint: true });
          location = {
            path: parent,
            scope: createHash("sha256").update(String(info.dev)).digest("hex"),
          };
          resolved.set(path, location);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent)
            throw error;
          parent = dirname(parent);
        }
      }
    }
    const info = await statfs(location.path, { bigint: true });
    const bytes = info.bavail * info.bsize;
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Storage size exceeds safe numeric range");
    return { scope: location.scope, availableBytes: Number(bytes > 0n ? bytes : 0n) };
  };
}

export class StartupDiskSampler {
  private readonly probe: Probe;
  private readonly scopes = new Map<string, Scope>();
  private readonly sealed = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(
    private readonly options: {
      probe?: Probe;
      onSample?: (summary: StartupDiskSummary[]) => void;
    } = {},
  ) {
    this.probe = options.probe ?? createProbe();
  }
  async addPath(path: string): Promise<void> {
    if (this.scopes.size >= 8 || this.stopped) return;
    const unknownKey = createHash("sha256").update(path).digest("hex");
    const unknown: Scope = {
      path,
      scopeId: unknownKey,
      baseline: null,
      observedAvailableDropPeakBytes: null,
      minAvailableBytes: null,
      quality: "unknown",
      sampledAt: null,
    };
    this.scopes.set(unknownKey, unknown);
    // 准备只短暂等待基线；慢探测继续异步运行，结果到达时据 sealBaseline 判定是否完整。
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.probe(path);
      if (this.stopped) return;
      this.scopes.delete(unknownKey);
      const existing = this.scopes.get(result.scope);
      if (existing) this.record(existing, result.availableBytes);
      else
        this.scopes.set(result.scope, {
          ...unknown,
          scopeId: result.scope,
          baseline: this.sealed.has(path) ? null : result.availableBytes,
          minAvailableBytes: result.availableBytes,
          sampledAt: Date.now(),
          observedAvailableDropPeakBytes: this.sealed.has(path) ? null : 0,
          quality: this.sealed.has(path) ? "partial" : "complete",
        });
    } catch {
      /* 满盘/权限错误不要求再次读取故障磁盘才能显示失败。 */
    } finally {
      this.busy = false;
    }
  }
  sealBaseline(path: string): void {
    this.sealed.add(path);
  }
  start(): void {
    if (!this.timer && !this.stopped)
      this.timer = setInterval(() => {
        void this.sample();
      }, SAMPLE_INTERVAL_MS);
  }
  async sample(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const scope of Array.from(this.scopes.values())) {
        if (this.stopped) break;
        try {
          const result = await this.probe(scope.path);
          if (!this.stopped) {
            if (scope.scopeId !== result.scope) {
              this.scopes.delete(scope.scopeId);
              const existing = this.scopes.get(result.scope);
              if (existing) {
                this.record(existing, result.availableBytes);
                continue;
              }
              scope.scopeId = result.scope;
              scope.quality = "partial";
              this.scopes.set(result.scope, scope);
            }
            this.record(scope, result.availableBytes);
          }
        } catch {
          if (scope.quality === "complete") scope.quality = "partial";
        }
      }
      if (!this.stopped) this.options.onSample?.(this.snapshot());
    } finally {
      this.busy = false;
    }
  }
  private record(scope: Scope, available: number): void {
    scope.minAvailableBytes = Math.min(scope.minAvailableBytes ?? available, available);
    scope.sampledAt = Date.now();
    if (scope.baseline !== null)
      scope.observedAvailableDropPeakBytes = Math.max(0, scope.baseline - scope.minAvailableBytes);
  }
  snapshot(): StartupDiskSummary[] {
    return [...this.scopes.values()].map(({ path: _path, baseline: _baseline, ...summary }) => ({
      ...summary,
    }));
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
