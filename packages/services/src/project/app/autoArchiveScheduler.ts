import type { AutoArchiveInput, ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectTaskRef } from "#src/project/domain/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/** 扫描只读一次设置 + 一次索引小查询；5 分钟让刚超期任务尽快离开列表。 */
const TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

const TASK_AUTO_ARCHIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "taskAutoArchiveEnabled",
  "taskAutoArchiveOlderThanDays",
]);

export function shouldRescanTaskAutoArchive(keys: readonly string[]): boolean {
  return keys.some((key) => TASK_AUTO_ARCHIVE_SETTING_KEYS.has(key));
}

interface TaskAutoArchiveSchedulerOptions {
  /** 读取当前策略；返回 null 表示自动归档关闭。 */
  readPolicy(): Promise<AutoArchiveInput | null>;
  repository(): Promise<Pick<ProjectRepositoryContract, "archiveInactive">>;
  /** 至少归档一条后调用，负责广播项目变更；没有变化时不调用。 */
  afterChange(): Promise<void>;
  intervalMs?: number;
}

interface TaskAutoArchiveScheduler {
  /** 立即扫描一次并按固定间隔重复；重复调用无效。 */
  start(): void;
  /** 串行扫描；扫描进行中的调用合并为一次补扫。返回本次归档的任务。 */
  scan(): Promise<ProjectTaskRef[]>;
  dispose(): void;
}

/**
 * 自动归档的唯一触发者：启动首轮 + 固定间隔 + 设置变更补扫。
 * 读取/点击路径绝不调用归档；否则点开旧未读任务会因列表刷新把它归档，表现为“点了打不开”。
 */
export function createTaskAutoArchiveScheduler(
  options: TaskAutoArchiveSchedulerOptions,
): TaskAutoArchiveScheduler {
  const log = createServiceLogger("task-auto-archive");
  const intervalMs = options.intervalMs ?? TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let running: Promise<ProjectTaskRef[]> | null = null;
  let queued: Promise<ProjectTaskRef[]> | null = null;

  const runOnce = async (): Promise<ProjectTaskRef[]> => {
    const policy = await options.readPolicy();
    if (!policy || disposed) return [];
    const archived = (await options.repository()).archiveInactive(policy);
    if (archived.length === 0) return archived;
    // 只记录数量与截止时间；不输出 taskId/路径等用户信息。
    log.info(undefined, `自动归档 ${archived.length} 条任务`, { cutoff: policy.cutoff });
    await options.afterChange();
    return archived;
  };

  const scan = (): Promise<ProjectTaskRef[]> => {
    if (disposed) return Promise.resolve([]);
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
      return running;
    }
    // 设置变更与定时器可能撞在同一轮：进行中的扫描读的是旧策略，结束后必须再扫一次。
    queued ??= running
      .catch(() => [])
      .then(() => {
        queued = null;
        return scan();
      });
    return queued;
  };

  const scanInBackground = () => {
    void scan().catch((error) => {
      log.warn(undefined, "自动归档扫描失败，等待下一轮", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    start() {
      if (timer || disposed) return;
      scanInBackground();
      timer = setInterval(scanInBackground, intervalMs);
      timer.unref?.();
    },
    scan,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
