import { traceContextToLogContext } from "../deps.js";
import type { RuntimeCommand, TaskNotificationRuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runRuntimeCommand, runTaskNotificationBatch } from "./runtime-command-execution.js";
import { noteWorkflowReminderCommandStarted } from "./dynamic-workflow-blocked-reminder.js";
import type {
  AcquireForegroundPromotionLeaseResult,
  ForegroundPromotionLeaseMode,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
} from "../types.js";

export function enqueueRuntimeCommand(this: AgentRuntimeInternal, command: RuntimeCommand): void {
  this.runtimeCommandQueue.enqueue(command);
  if (command.mode === "task-notification") {
    this.logger?.info?.("Background task notification enqueued into runtime command queue", {
      ...traceContextToLogContext(command.traceContext),
      commandId: command.id,
      event: "background_task.notification.runtime_enqueued",
      module: "core.runtime",
      queueSize: this.runtimeCommandQueue.size(),
    });
  }
  void this.drainRuntimeCommandQueue();
}

export async function drainRuntimeCommandQueue(this: AgentRuntimeInternal): Promise<void> {
  if (this.runtimeCommandDrainActive) return;

  this.runtimeCommandDrainActive = true;
  try {
    let commands: readonly RuntimeCommand[];
    // 将同批后台通知合并到一个模型轮，避免每条通知都单独发起请求。
    while ((commands = dequeueNextRunnableBatch.call(this)).length > 0) {
      const firstCommand = commands[0];
      if (!firstCommand) continue;
      noteWorkflowReminderCommandStarted(this, firstCommand);
      if (firstCommand.mode === "task-notification") {
        const notificationCommands = commands.filter(
          (command): command is TaskNotificationRuntimeCommand =>
            command.mode === "task-notification",
        );
        if (notificationCommands.length !== commands.length) {
          throw new Error("Runtime command queue returned a mixed task-notification batch");
        }
        await runTaskNotificationBatch.call(this, notificationCommands);
        continue;
      }
      if (commands.length !== 1) {
        throw new Error(`Runtime command queue returned an unsupported ${firstCommand.mode} batch`);
      }
      await runRuntimeCommand.call(this, firstCommand);
    }
  } finally {
    this.runtimeCommandDrainActive = false;
  }

  if (this.runtimeCommandQueue.hasPending() && this.foregroundPromotionLease === undefined) {
    await this.drainRuntimeCommandQueue();
    return;
  }
  // 空闲沿：队列排空，且没有任何在跑 / 排着 / 预留的回合（持着晋升租约、或 prompt 已预留未入队时不算，
  // 那一轮自己排空时会再走到这里）。「run 还欠着决定」的提醒钟从这里起算。
  if (!hasActiveOrQueuedTurnWork.call(this)) this.workflowBlockedReminder?.sessionIdle();
}

function dequeueNextRunnableBatch(this: AgentRuntimeInternal): readonly RuntimeCommand[] {
  const lease = this.foregroundPromotionLease;
  if (!lease) return this.runtimeCommandQueue.dequeueNextBatch();

  const promotedCommand = this.runtimeCommandQueue
    .snapshot()
    .find((command) => runtimeCommandInputId(command) === lease.promotedInputId);
  if (!promotedCommand) return Object.freeze([]);
  const removedPromotedCommand = this.runtimeCommandQueue.removeById(promotedCommand.id);
  if (!removedPromotedCommand) return Object.freeze([]);

  // sendQueuedNow 过去在 Stop A 与 promoted command 入队之间没有 Core
  // 调度所有权，notification B 会抢先出队。匹配 command 出队与 lease 消费必须同一同步步。
  this.foregroundPromotionLease = undefined;
  return Object.freeze([removedPromotedCommand]);
}

function runtimeCommandInputId(command: RuntimeCommand): string | undefined {
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.inputId;
  }
  return undefined;
}

export function hasActiveOrQueuedTurnWork(this: AgentRuntimeInternal): boolean {
  return (
    this.foregroundPromotionLease !== undefined ||
    this.activeForegroundExecution !== undefined ||
    this.runtimeCommandDrainActive ||
    this.runtimeCommandQueue.hasPending() ||
    this.activeTurn !== undefined ||
    this.activeTurnStartReservation !== undefined
  );
}

export function acquireForegroundPromotionLease(
  this: AgentRuntimeInternal,
  options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  },
): AcquireForegroundPromotionLeaseResult {
  const existing = this.foregroundPromotionLease;
  if (existing) {
    return existing.leaseId === options.leaseId
      ? { kind: "acquired", leaseId: existing.leaseId }
      : { kind: "conflict", leaseId: existing.leaseId };
  }
  if (
    options.mode === "idle-only" &&
    (this.activeForegroundExecution !== undefined ||
      this.runtimeCommandDrainActive ||
      this.runtimeCommandQueue.hasPending() ||
      this.activeTurn !== undefined ||
      this.activeTurnStartReservation !== undefined)
  ) {
    return { kind: "busy" };
  }
  this.foregroundPromotionLease = {
    leaseId: options.leaseId,
    promotedInputId: options.promotedInputId,
  };
  return { kind: "acquired", leaseId: options.leaseId };
}

export function releaseForegroundPromotionLease(
  this: AgentRuntimeInternal,
  leaseId: string,
): boolean {
  if (this.foregroundPromotionLease?.leaseId !== leaseId) return false;
  this.foregroundPromotionLease = undefined;
  // 启动前失败时 B 可能已在 lease 后等待；释放必须主动恢复 drain，不能等下一条 enqueue。
  void this.drainRuntimeCommandQueue();
  return true;
}

export function stopActiveForegroundExecution(
  this: AgentRuntimeInternal,
  options: StopActiveForegroundExecutionOptions = {},
): StopActiveForegroundExecutionResult {
  const active = this.activeForegroundExecution;
  if (!active || active.controller.signal.aborted) {
    return { kind: "idle" };
  }
  if (
    options.expectedForegroundExecutionId !== undefined &&
    options.expectedForegroundExecutionId !== active.foregroundExecutionId
  ) {
    return {
      kind: "mismatch",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  // sendQueuedNow 的内部抢占过去与用户手动 Stop 共用同一种 cancelled，
  // turn catch 因而把 queueAutoDrain 关闭。把调用意图固定在当前 foreground
  // execution 上，保证超时后迟到的 TurnComplete 仍能保留原队列授权。
  active.preserveQueueAutoDrainOnCancel = options.preserveQueueAutoDrainOnCancel === true;
  active.controller.abort(new Error(options.reason ?? "foreground execution stopped"));
  return {
    kind: "stopped",
    foregroundExecutionId: active.foregroundExecutionId,
  };
}

export function getActiveForegroundExecutionId(this: AgentRuntimeInternal): string | undefined {
  return this.activeForegroundExecution?.foregroundExecutionId;
}
