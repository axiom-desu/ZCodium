import { performance } from "node:perf_hooks";
import type { LogContext, Logger } from "@zcode/contracts";

interface StartupTimerLogOptions {
  context?: LogContext;
  event: string;
  stage: string;
}

export class StartupTimer {
  private lastMarkAt: number;

  constructor(
    private readonly logger: Logger,
    private readonly baseContext: LogContext,
    private readonly startedAt: number = startupNow(),
  ) {
    this.lastMarkAt = startedAt;
  }

  start(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.info(message, this.createContext(options, now, 0, "started"));
  }

  mark(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    const durationMs = elapsedMs(this.lastMarkAt, now);
    this.lastMarkAt = now;
    this.logger.info(message, this.createContext(options, now, durationMs, "completed"));
  }

  complete(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.info(
      message,
      this.createContext(options, now, elapsedMs(this.startedAt, now), "completed"),
    );
  }

  fail(message: string, error: unknown, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.error(
      message,
      toError(error),
      this.createContext(options, now, elapsedMs(this.startedAt, now), "failed"),
    );
  }

  private createContext(
    options: StartupTimerLogOptions,
    now: number,
    durationMs: number,
    status: NonNullable<LogContext["status"]>,
  ): LogContext {
    return {
      ...this.baseContext,
      ...options.context,
      durationMs,
      event: options.event,
      stage: options.stage,
      status,
      totalDurationMs: elapsedMs(this.startedAt, now),
    };
  }
}

export function startupNow(): number {
  return performance.now();
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}
