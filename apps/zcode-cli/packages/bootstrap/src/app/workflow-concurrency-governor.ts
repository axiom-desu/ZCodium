// ============================================================
// Workflow 并发治理器（进程级，按 provider key 分桶，**每个模型请求**准入）
// ============================================================
// 一个 CLI 进程里所有 run 加主代理
// 共用一个 provider 配额，所以治理器是**进程级**的：每个 `${providerId}/${modelId}` 一个桶，
// 桶里一台纯 AIMD 状态机（`ConcurrencyController`，@zcode/dynamic-workflow）+ 一条按 run 轮转的
// 准入队列。
//
// 闸门粒度是**模型请求的每一次尝试**：runner 每次尝试前 `acquire`、尝试结束 `release`，
// 退避 sleep 期间不持槽。ticket 就是该次尝试的状态事件汇：runner 把该尝试的
// `ModelNetworkStatus` 事件同时投递给 ticket，治理器从 ticket 上读结果。本方案
// 同一事件只经 ticket 投递一次，避免重复调整并发窗口。
//
// 这里是治理器里**唯一**会碰时钟与定时器的地方：控制器只收 `now`；冷却到期要唤醒等待者，
// 所以需要一个 setTimeout（可注入，unref）。

import { resolveWorkflowModelFailurePolicy } from "@zcode/adapters/model";
import {
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelRequestFailedStatusEvent,
  type ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";

/** provider key：最具体的配额键。 */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * driver 看到的窄端口（不是整个治理器）。
 *
 * - `tryAdmit`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `admit` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `admit`：排队（run 间轮转）直到 `inFlight < cap` 且不在 Retry-After 冷却；`signal` 被 abort 即
 *   出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。扇出只到**此刻在该 key 上有在飞或排队请求**的
 *   run。
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * 主代理用的 admission：acquire 立即放行——不排队、不看冷却——但**计入 inFlight**
   * 且喂信号（它的请求 provider 同样看得见）。主代理的 turn 永不被 workflow 流量阻塞。
   */
  observer(): ModelRequestAdmission;
  /** 控制器只读快照；没有这个 key 的桶时为 undefined。 */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** 天花板：桶创建时的初值与上界；进程启动时算一次。 */
  ceiling: number;
  /** 时钟（可注入）。 */
  now?: () => number;
  /** 定时器（可注入）：冷却到期唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 限流类 retry 原因 → 控制器的 throttled 信号。 */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
]);
/** 不是 provider 失败的 retry 原因：既不减 cap 也不清 streak——只当尝试终结。 */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** 每个 run 在飞（已准入未结算）的请求数（扇出的依据：有在飞或排队请求的 run 才收 cap 变化）。 */
  readonly inFlightByRun: Map<string, number>;
  /** 等待者按 run 分队列（run 间轮转，大 fan-out 不能饿死后来的小 run）。 */
  readonly queues: Map<string, Waiter[]>;
  /** 轮转游标：上一次放行的 run，下一次从它之后开始找。 */
  lastGrantedRun?: string;
  cancelCooldownWake?: () => void;
}

/** observer（主代理）的 run 身份：不排队、不订阅，只在扇出过滤里作为「不是任何 run」出现。 */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等冷却的定时器把进程钉住：run 结束、进程要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * 造一台治理器。只在进程单例与测试里调用：时钟与定时器可注入，其余状态全在闭包里。
 */
export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** run 级订阅（不按 key）：扇出时按桶的 engaged 集合过滤。 */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // 惰性建桶，初值 = 天花板；此后 run 来来去去都不重置它（只有空闲 5 分钟会）。
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.ceiling),
        inFlightByRun: new Map(),
        queues: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /** 扇出：只给此刻在该 key 上有在飞或排队请求的 run。 */
  const fanOut = (bucket: Bucket, changes: ConcurrencyChange[]): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 || (bucket.queues.get(runId)?.length ?? 0) > 0;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * 一次已准入尝试的 ticket：事件映射保持一致。任一终结映射后结算（幂等）；`release()`
   * 未见终结事件即按 `ended` 处理。结算后的 publish / release 一律惰性——runner 在极少数路径上
   * （尝试已结束后的兜底事件）可能仍会投递。
   */
  const mintTicket = (
    bucket: Bucket,
    runId: string,
    epoch: number,
  ): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // 先扇出再减在飞：产生这条变化的请求正是本 run 的，它此刻仍算 engaged——否则一个 run 唯一的
      // 在飞请求撞出的减半，会因为「已经不在飞」而漏发给它自己。
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // 结算释放了一个名额（或改了 cap），排队者可能可以放行。
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // 准入时已计入 inFlight，这里没有新信息。
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // retryable:true 的 failed 紧随一条 retry_scheduled——那条才是信号。
            if (event.retryable) return;
            // Stop 集（配额、认证…）不是并发信号，只终结尝试。曾经配额 429 走下面的限流分支：
            // 1308 带的 Retry-After 指到额度窗口结束（可达数小时），冷却冻住整个桶、活得比停下的 run
            // 还久；用户用重置卡恢复额度后 resume，子代理全卡在闸门上一个请求不发，主代理（observer
            // 不看冷却）却照常工作，换模型（换桶）才继续。何时再试由用户决定，与 driver 读同一张策略表。
            if (isWorkflowStopFailure(event)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            // 不可重试的限流：
            // 主对话 / 工具侧撞上 3008 这类被分类器判终止的 429，仍是一次字面意义上的并发信号——
            // 只当「链结束」会让 cap 从未因它降过。
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** 放行一个请求：`observe` 在前（准入也是一次「信号」），再 `admitted` 拿 epoch。 */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** 按轮转挑下一个有等待者的 run。 */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter(
      (runId) => (bucket.queues.get(runId)?.length ?? 0) > 0,
    );
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** 放行尽可能多的等待者（闸门：inFlight < cap 且不在冷却），喂 waiters，必要时定冷却闹钟。 */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) => {
    const bucket = bucketFor(key);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  // 不排队、不看冷却；observe 在 grant 里。快路径总命中，所以 runner 永远不会为主代理
  // 的请求发 queued / admitted。
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

/**
 * 不可重试的失败是否落在 workflow 策略表的 Stop 集里。runner（重试闸门）与 driver（stopRun）
 * 读的是同一个函数，三层对 Stop 集的判断不会分叉；缺 `errorCode` 时按通用请求失败读，
 * 配额判定只看业务码（1005 的 reason 是 invalid_request，必须先按码判配额）。
 */
function isWorkflowStopFailure(event: ModelRequestFailedStatusEvent): boolean {
  return (
    resolveWorkflowModelFailurePolicy(
      {
        code: event.errorCode ?? ModelErrorCode.ModelRequestFailed,
        reason: event.reason,
        retryable: event.retryable,
      },
      event.providerErrorCode,
    ).decision === "stop"
  );
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * 进程级单例：天花板在首次取用时算一次；此后每个 app（会话）的主 runtime 挂它的
 * observer，run service 拿同一个端口给 driver。
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    ceiling: resolveWorkflowConcurrencyCeiling(),
  });
  return processGovernor;
}
