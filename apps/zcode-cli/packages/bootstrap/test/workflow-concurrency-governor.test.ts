// ============================================================
// workflow 并发治理器的 Stop 集（3.16.2）
// ============================================================
// 治理器与 runner/driver 读**同一张** workflow 失败策略表：不可重试失败落在 Stop 集里时只终结尝试，
// 不降 cap、不按 Retry-After 冷却。曾经配额 429（1308）走的限流分支会把整桶冻到额度窗口结束
// （可达数小时），活得比停下的 run 还久；用户换额度后 resume 也进不来。
//
// 这里用真的 `ConcurrencyController`（纯 AIMD 状态机），只注入时钟与定时器。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelNetworkStatusEvent, ModelRequestTarget } from "@zcode/contracts";
import { ModelErrorCode } from "@zcode/contracts";
import {
  createWorkflowConcurrencyGovernor,
  workflowConcurrencyKey,
} from "../src/app/workflow-concurrency-governor.js";

const MODEL_A: ModelRequestTarget = { modelId: "alpha", providerId: "prov" };
const KEY_A = workflowConcurrencyKey(MODEL_A);
const CEILING = 8;
const HOUR_MS = 60 * 60 * 1_000;

/** 假时钟 + 假定时器：治理器唯一的 I/O 面。 */
function fakeClock(): {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
  advance: (ms: number) => void;
} {
  let current = 1_000_000;
  const timers: Array<{ at: number; cancelled: boolean; fire: () => void }> = [];
  return {
    advance: (ms) => {
      current += ms;
      for (const entry of timers.filter((timer) => !timer.cancelled && timer.at <= current)) {
        entry.cancelled = true;
        entry.fire();
      }
    },
    now: () => current,
    schedule: (callback, delayMs) => {
      const entry = { at: current + delayMs, cancelled: false, fire: callback };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

function statusEvent(
  partial: Record<string, unknown> & { type: ModelNetworkStatusEvent["type"] },
): ModelNetworkStatusEvent {
  return {
    attempt: 1,
    maxAttempts: 0,
    model: MODEL_A,
    requestId: "req",
    timestamp: new Date(0).toISOString(),
    traceId: "trace",
    transport: "http",
    ...partial,
  } as unknown as ModelNetworkStatusEvent;
}

function governorHarness(): {
  governor: ReturnType<typeof createWorkflowConcurrencyGovernor>;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const governor = createWorkflowConcurrencyGovernor({
    ceiling: CEILING,
    now: clock.now,
    schedule: clock.schedule,
  });
  return { clock, governor };
}

/** 一次不可重试的终止失败（runner 在这一支之前不会发 retry_scheduled）。 */
function failTerminally(
  ticket: { publish: (event: ModelNetworkStatusEvent) => void },
  extra: Record<string, unknown>,
): void {
  ticket.publish(statusEvent({ type: "model_request_started" }));
  ticket.publish(
    statusEvent({
      type: "model_request_failed",
      message: "provider failed",
      reason: "rate_limited",
      retryable: false,
      ...extra,
    }),
  );
}

describe("治理器的 Stop 集", () => {
  it("配额 1308 + Retry-After 3h：不冷却、cap 不变、随后 tryAdmit 立即成功", () => {
    const { governor, clock } = governorHarness();
    const ticket = governor.tryAdmit("run-a", KEY_A);
    assert.ok(ticket);
    failTerminally(ticket, {
      errorCode: ModelErrorCode.ModelRequestFailed,
      providerErrorCode: "1308",
      retryAfterMs: 3 * HOUR_MS,
      statusCode: 429,
    });

    const snapshot = governor.snapshot(KEY_A);
    assert.equal(snapshot?.cooldownUntil, undefined);
    assert.equal(snapshot?.cap, CEILING);
    assert.equal(snapshot?.inFlight, 0);

    // run 立即可以再准入（何时再试由用户决定，不由冻结的桶决定）。
    const retried = governor.tryAdmit("run-a", KEY_A);
    assert.ok(retried, "配额失败后闸门必须立刻打开");
    retried.release();
    assert.equal(governor.snapshot(KEY_A)?.inFlight, 0);
    clock.advance(1);
  });

  it("配额 Stop 对 observer（主代理）同样不冻桶：cap 保持，后续请求照常准入", () => {
    const { governor } = governorHarness();
    const admission = governor.observer();
    const ticket = admission.tryAcquire?.({ model: MODEL_A });
    assert.ok(ticket);
    failTerminally(ticket, { providerErrorCode: "insufficient_quota", statusCode: 429 });

    assert.equal(governor.snapshot(KEY_A)?.cooldownUntil, undefined);
    assert.equal(governor.snapshot(KEY_A)?.cap, CEILING);
    assert.ok(admission.tryAcquire?.({ model: MODEL_A }), "observer 依旧立即放行");
  });

  it("认证失败（Stop 集另一行）：只终结尝试，cap 与冷却都不动", () => {
    const { governor } = governorHarness();
    const ticket = governor.tryAdmit("run-a", KEY_A);
    assert.ok(ticket);
    ticket.publish(statusEvent({ type: "model_request_started" }));
    ticket.publish(
      statusEvent({
        type: "model_request_failed",
        errorCode: ModelErrorCode.ModelRequestAuthMissing,
        message: "401",
        reason: "auth_failed",
        retryable: false,
        statusCode: 401,
      }),
    );
    assert.equal(governor.snapshot(KEY_A)?.cooldownUntil, undefined);
    assert.equal(governor.snapshot(KEY_A)?.cap, CEILING);
  });

  it("不可重试的 3008 仍按并发信号处理：throttled、冷却与 cap 照旧", () => {
    const { governor } = governorHarness();
    const ticket = governor.tryAdmit("run-a", KEY_A);
    assert.ok(ticket);
    failTerminally(ticket, {
      errorCode: ModelErrorCode.ModelRequestFailed,
      providerErrorCode: "3008",
      retryAfterMs: 2_000,
      statusCode: 429,
    });

    const snapshot = governor.snapshot(KEY_A);
    assert.equal(snapshot?.cooldownUntil, snapshot === undefined ? 0 : 1_000_000 + 2_000);
    assert.equal(snapshot?.cap, Math.max(1, Math.floor(CEILING * 0.75)));
    // 冷却期内闸门关着：这是「可恢复限流仍退避」的原有语义。
    assert.equal(governor.tryAdmit("run-a", KEY_A), undefined);
  });

  it("可重试限流（retryable failed + retry_scheduled）语义不变：throttled + Retry-After 冷却", () => {
    const { governor, clock } = governorHarness();
    const ticket = governor.tryAdmit("run-a", KEY_A);
    assert.ok(ticket);
    ticket.publish(statusEvent({ type: "model_request_started" }));
    ticket.publish(
      statusEvent({
        type: "model_request_failed",
        message: "429",
        reason: "rate_limited",
        retryable: true,
      }),
    );
    ticket.publish(
      statusEvent({
        type: "model_retry_scheduled",
        delayMs: 1_000,
        message: "429",
        nextAttempt: 2,
        reason: "rate_limited",
        retryAfterMs: 5_000,
      }),
    );

    const snapshot = governor.snapshot(KEY_A);
    assert.equal(snapshot?.cooldownUntil, 1_000_000 + 5_000);
    assert.equal(snapshot?.cap, Math.max(1, Math.floor(CEILING * 0.75)));
    assert.equal(governor.tryAdmit("run-a", KEY_A), undefined);

    // 冷却到期后重新放行（定时器唤醒等待者，这里直接推进时钟再试）。
    clock.advance(5_000);
    assert.ok(governor.tryAdmit("run-a", KEY_A));
  });
});
