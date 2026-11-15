import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelApiCallObservation } from "../model/observation.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
} from "./index.js";

/**
 * 会话用过的能力标签，adapter 写入受控请求头 `x-zcode-session-features`（上游 3.18.2 F12）。
 * 词表只追加；值必须是小写 snake_case。标签只增不减：compact、rewind、冷恢复都不撤销。
 */
export const ModelRequestSessionFeature = {
  BrowserUse: "browser_use",
  ComputerUse: "computer_use",
  ToolSearchCalled: "tool_search_called",
  ToolSearchLocal: "tool_search_local",
  ToolSearchNative: "tool_search_native",
  WorkflowAuto: "workflow_auto",
  WorkflowAutoAttempt: "workflow_auto_attempt",
  WorkflowCmd: "workflow_cmd",
} as const;

export type ModelRequestSessionFeature =
  (typeof ModelRequestSessionFeature)[keyof typeof ModelRequestSessionFeature];

const MODEL_REQUEST_SESSION_FEATURE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ModelRequestSessionFeature),
);

export function isModelRequestSessionFeature(
  value: unknown,
): value is ModelRequestSessionFeature {
  return typeof value === "string" && MODEL_REQUEST_SESSION_FEATURE_VALUES.has(value);
}

/**
 * Runtime 与 Adapter 之间的调用级执行信息。
 *
 * 它不属于业务 ModelRequest，也不允许普通调用方据此改变 Provider 或模型身份。
 * Runtime 只在统一模型调用边界设置，Adapter 在同一异步调用链内读取。
 */
export interface ModelInvocationContext {
  metadata?: Record<string, unknown>;
  modelCall?: ModelApiCallObservation;
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * 本会话已用能力标签；runtime 每次模型调用读取 owner 的当前集合。Adapter 写入受控 header，
   * 不允许 provider 静态 headers 覆盖；缺省或空集合时不发送。
   */
  modelRequestSessionFeatures?: readonly ModelRequestSessionFeature[];
  /** 重试预算档位；runtime 按 taskType 决定，adapter 据此放宽瞬态失败的放弃条件。 */
  modelRetryBudget?: ModelRetryBudget;
  /** 准入端口；runtime 从 deps 带入，adapter 每次尝试先 acquire。 */
  modelRequestAdmission?: ModelRequestAdmission;
  statusSink?: ModelStatusSink;
  traceContext?: TraceContext;
  streamIdleTimeoutRetryNumber?: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  preserveProviderStreamBoundaries?: boolean;
}

const modelInvocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

export function getCurrentModelInvocationContext(): ModelInvocationContext | undefined {
  return modelInvocationStorage.getStore();
}

export function runWithModelInvocationContext<T>(context: ModelInvocationContext, run: () => T): T {
  const result = modelInvocationStorage.run(context, run);
  if (!isAsyncIterable(result)) return result;

  const source = result;
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) =>
          modelInvocationStorage.run(context, () => iterator.next(value as never)),
        return: (value?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.return
              ? iterator.return(value as never)
              : Promise.resolve({ done: true, value }),
          ),
        throw: (error?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      };
    },
  } as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}
