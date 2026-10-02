// Local diagnostic records share the same allowlist as optional export.
import { homedir } from "node:os";
import { appendBoundedDiagnosticLine } from "./bounded-log-file.js";
import { basename, join } from "node:path";
import type { LogContext, Logger, LoggerFactory } from "@zcode/contracts";
import { LogLevel, LogLevelName } from "@zcode/contracts";
import {
  ZCODE_RUNTIME_ENV_KEY,
  normalizeZCodeRuntimeEnv,
  safeLogArgs,
  DiagnosticRecordSchema,
  DiagnosticMetricSchema,
  createDiagnosticTraceId,
  createDiagnosticSpanId,
  ZCODE_USER_DATA_DIR_NAME,
  type DiagnosticRecord,
} from "@zcode/shared";
import {
  formatLocalLogDate,
  scheduleLogRetentionCleanup as scheduleRetentionCleanup,
  type LogRetentionScheduleOptions,
  type LogRetentionTimer,
} from "./retention.js";

export {
  LOG_CLEANUP_STARTUP_DELAY_MS,
  LOG_RETENTION_DAYS,
  cleanupLogRetention,
  formatLocalLogDate,
  scheduleLogRetentionCleanup,
} from "./retention.js";
export type {
  LogRetentionCleanupOptions,
  LogRetentionCleanupResult,
  LogRetentionScheduleOptions,
  LogRetentionTimer,
} from "./retention.js";

export interface NodeLoggerFactoryOptions {
  env?: NodeJS.ProcessEnv;
  logDir?: string;
  minLevel?: LogLevel;
  console?: boolean | { stream: NodeJS.WritableStream };
  /** Only validated diagnostic records reach an explicitly owned local/optional export sink. */
  onDiagnostic?: (record: DiagnosticRecord) => void;
}
export type NodeLogRetentionScheduleOptions = Pick<
  LogRetentionScheduleOptions,
  "delayMs" | "logger" | "now" | "retentionDays" | "setTimeout"
>;
export interface NodeLoggerFactory extends LoggerFactory {
  getLogDir(): string;
  flush(): Promise<void>;
  scheduleLogRetentionCleanup(
    options?: NodeLogRetentionScheduleOptions,
  ): LogRetentionTimer | undefined;
}
interface DiagnosticWriter {
  write(level: LogLevel, record: DiagnosticRecord, args: unknown[]): void;
  flush(): Promise<void>;
}

export class NodeFileLogger implements Logger {
  constructor(
    private readonly options: {
      defaultContext?: LogContext;
      getMinLevel: () => LogLevel;
      writer: DiagnosticWriter;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
    },
  ) {
    // child 的默认上下文也只能持有安全字段，避免把路径/正文留在长寿命 logger 对象中。
    this.options.defaultContext = safeLogArgs([options.defaultContext ?? {}])[0] as LogContext;
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.Debug, message, undefined, context);
  }
  info(message: string, context?: LogContext): void {
    this.log(LogLevel.Info, message, undefined, context);
  }
  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.Warn, message, undefined, context);
  }
  error(message: string, error?: Error, context?: LogContext): void {
    this.log(LogLevel.Error, message, error, context);
  }
  child(context: LogContext): Logger {
    return new NodeFileLogger({
      ...this.options,
      defaultContext: { ...this.options.defaultContext, ...context },
      parentSpanId: this.options.spanId,
      spanId: createDiagnosticSpanId(),
    });
  }

  private log(level: LogLevel, message: string, error?: Error, context?: LogContext): void {
    if (level < this.options.getMinLevel()) return;
    try {
      // 旧业务 context 只在同步边界读取；任何持久/console/export 路径都只能看到白名单记录。
      const mergedContext = { ...this.options.defaultContext, ...context };
      const status = mergedContext.status;
      const safeStatus = status === "completed" ? "ok" : status === "failed" ? "error" : status;
      const phase =
        status === "started"
          ? "start"
          : status === "completed" || status === "failed" || status === "cancelled"
            ? "end"
            : undefined;
      const args = safeLogArgs([
        message,
        { ...mergedContext, status: safeStatus, ...(phase ? { phase } : {}) },
        error,
      ]);
      let diagnostic: DiagnosticRecord | undefined;
      for (const arg of args) {
        const parsed = DiagnosticRecordSchema.safeParse(arg);
        if (parsed.success) {
          diagnostic = parsed.data;
          break;
        }
      }
      const safeContext =
        args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : {};
      const metrics = Object.fromEntries(
        Object.entries(safeContext).filter(
          ([key, value]) =>
            DiagnosticMetricSchema.safeParse(key).success && typeof value === "number",
        ),
      );
      const record = DiagnosticRecordSchema.parse({
        ...(diagnostic ?? {
          version: 1,
          name: "log",
          metrics,
          ...Object.fromEntries(
            Object.entries(safeContext).filter(([key]) =>
              [
                "status",
                "phase",
                "stage",
                "transport",
                "errorCategory",
                "errorCode",
                "operation",
              ].includes(key),
            ),
          ),
        }),
        component: "agent",
        traceId: this.options.traceId,
        spanId: createDiagnosticSpanId(),
        parentSpanId: this.options.spanId,
      });
      this.options.writer.write(level, record, args);
    } catch {
      // 诊断故障不能改变工具、会话或协议执行结果。
    }
  }
}

export function createNodeLoggerFactory(options: NodeLoggerFactoryOptions = {}): NodeLoggerFactory {
  let currentLevel = options.minLevel ?? getDefaultMinLevel(options.env);
  let retentionCleanupScheduled = false;
  const rootDir = options.logDir ?? options.env?.ZCODE_LOG_DIR ?? getDefaultLogDir();
  // 已有日志可能含原文，版本目录隔离避免混入新的白名单记录与导出。
  const logDir = basename(rootDir) === "diagnostics-v1" ? rootDir : join(rootDir, "diagnostics-v1");
  const consoleStream =
    typeof options.console === "object"
      ? options.console.stream
      : options.console === true || options.env?.ZCODE_LOG_CONSOLE === "1"
        ? process.stderr
        : undefined;
  const traceId = createDiagnosticTraceId();
  let sequence = 0;
  let pending = 0;
  let writes = Promise.resolve();
  const writer: DiagnosticWriter = {
    write(level, input, args) {
      const record = { ...input, sequence: sequence++ };
      const line = JSON.stringify({
        version: 1,
        component: "agent",
        timestamp: new Date().toISOString(),
        level: LogLevelName[level],
        diagnostic: record,
        args,
      });
      try {
        consoleStream?.write(`${line}\n`);
      } catch {
        /* closed local console */
      }
      try {
        options.onDiagnostic?.(record);
      } catch {
        /* optional diagnostic sink */
      }
      if (pending >= 1024) return;
      pending += 1;
      writes = writes
        .then(async () => {
          await appendBoundedDiagnosticLine(
            join(logDir, `zcode-${formatLocalLogDate(new Date())}.jsonl`),
            `${line}\n`,
            level === LogLevel.Debug,
          );
        })
        .catch(() => undefined)
        .finally(() => {
          pending -= 1;
        });
    },
    flush: () => writes,
  };
  const create = (defaultContext: LogContext = {}) =>
    new NodeFileLogger({
      defaultContext,
      getMinLevel: () => currentLevel,
      writer,
      traceId,
      spanId: createDiagnosticSpanId(),
    });
  return {
    createLogger: (_category) => create(),
    withContext: (context) => create(context),
    setLevel: (level) => {
      currentLevel = level;
    },
    getLogDir: () => logDir,
    flush: writer.flush,
    scheduleLogRetentionCleanup(scheduleOptions = {}) {
      if (retentionCleanupScheduled) return undefined;
      retentionCleanupScheduled = true;
      return scheduleRetentionCleanup({
        ...scheduleOptions,
        logDir,
        logger: scheduleOptions.logger ?? create(),
      });
    },
  };
}

export function getDefaultLogDir(): string {
  return join(homedir(), ZCODE_USER_DATA_DIR_NAME, "cli", "log", "diagnostics-v1");
}

function getDefaultMinLevel(env: NodeJS.ProcessEnv | undefined): LogLevel {
  return isDevelopmentMode(env ?? process.env) ? LogLevel.Debug : LogLevel.Info;
}

function isDevelopmentMode(env: NodeJS.ProcessEnv): boolean {
  const runtimeEnv = normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
  if (runtimeEnv === "development") return true;
  if (runtimeEnv === "production" || runtimeEnv === "test") return false;

  // The local dev script runs `tsx src/main.ts`; packaged CLI entrypoints run from dist.
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.endsWith(".ts") && entrypoint.includes(`${join("packages", "cli", "src")}`);
}
