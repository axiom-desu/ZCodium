import {
  appSessionControlToolContracts,
  cliSessionControlToolContracts,
  sessionControlModelInstructions,
  SessionControlError,
  type SessionControlToolContract,
} from "@zcode/session-control/contracts";
import type {
  AppSessionTrustedContext,
  CliTrustedContext,
} from "@zcode/session-control/contracts";
import type { ToolEntry, ToolExecutionContext } from "../types.js";


const OUTPUT_BYTES = 32_768;
const TOOL_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 310_000;

/**
 * 规格 0.14：请求身份由工具层注入，不由模型发明。
 *
 * 正常路径用本次 `toolCallId`——每次调用唯一，首次调用天然得到稳定身份。重试是新的 toolCall，
 * 拿不到同一个身份，所以模型把上一次回执里的 `requestId` 放进 `retryOf`，由这里还原。
 */
function requestIdentity(input: unknown, toolCallId: string): string {
  const retryOf = (input as { retryOf?: unknown } | null)?.retryOf;
  return typeof retryOf === "string" ? retryOf : toolCallId;
}
function withRequestId(parsed: unknown, context: ToolExecutionContext): Record<string, unknown> {
  const { retryOf: _retryOf, ...rest } = parsed as Record<string, unknown>;
  return { ...rest, requestId: requestIdentity(parsed, context.toolCallId) };
}

/**
 * 子代理、无绑定执行面、根会话不符一律拒绝：会话工具不能逃逸到别的根或别的 workspace。
 * 绑定只能由启动装配注入，模型输入不参与这里任何判定。
 */
function requireBinding(context: ToolExecutionContext, kind: "cli" | "app") {
  const binding = context.sessionControl;
  if (!binding || binding.kind !== kind || context.runtimeScope === "subagent") {
    throw new SessionControlError(
      "forbidden",
      "Session control is unavailable in this execution context.",
    );
  }
  const trusted = binding.context();
  if (trusted.rootSession.sessionId !== context.sessionId || trusted.rootSession.kind !== kind) {
    throw new SessionControlError(
      "forbidden",
      "Session control root binding does not match the executing session.",
    );
  }
  return {
    binding,
    trusted: {
      ...trusted,
      signal: context.abortSignal,
      traceId: context.traceId,
      turnId: context.traceContext?.turnId ?? context.turnId,
      toolCallId: context.toolCallId,
    } satisfies CliTrustedContext | AppSessionTrustedContext,
  };
}

function createEntry(kind: "cli" | "app", definition: SessionControlToolContract): ToolEntry {
  // 名字用 PascalCase（规格 0.12）：snake_case 会命中 UI 的 legacy kind 前缀启发式，
  // 把 ReadSession 渲染成读文件卡、CreateSession 渲染成写文件卡。
  const readOnly = definition.readOnly;
  const timeoutMs = definition.method === "waitSessions" ? WAIT_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  const sideEffectScope = readOnly ? "none" : "system";
  const riskLevel = readOnly ? "low" : "medium";
  return {
    capability: definition.description,
    metadata: {
      name: definition.name,
      description: definition.description,
      searchHint: definition.hint,
      modelInstructions: sessionControlModelInstructions(definition),
      shouldDefer: true,
      readOnly,
      destructive: false,
      concurrentSafe: readOnly,
      sideEffectScope,
      riskLevel,
      needsApproval: !readOnly,
      maxOutputBytes: OUTPUT_BYTES,
      timeoutMs,
    },
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    runtimeInputSchema: definition.input,
    runtimeOutputSchema: definition.output,
    permission: {
      permission: `session_control.${definition.method}`,
      reason: definition.description,
      riskLevel,
      sideEffectScope,
      needsApproval: !readOnly,
      patternSources: ["toolName", "input"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: OUTPUT_BYTES,
      maxModelBytes: OUTPUT_BYTES,
      strategy: "artifact",
      preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
      artifact: { enabled: true, retention: "session" },
    },
    timeout: { defaultMs: timeoutMs, maxMs: timeoutMs, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "required",
      // 规格 0.15：模型拿不到原始身份，不要让它「用原始身份对账」；它只能用回执里的 requestId。
      userVisibleMessage: "Session control cancelled. Target work is not stopped.",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      const { binding, trusted } = requireBinding(context, kind);
      context.abortSignal.throwIfAborted();
      const raw = definition.input.parse(input);
      const parsed = definition.hasRetryIdentity ? withRequestId(raw, context) : raw;
      // 此表只包含静态声明的有限方法；schema 与 facade 均来自公共契约，不读存储或选择另一 surface。
      const method = (
        binding.control as unknown as Record<
          string,
          (ctx: CliTrustedContext | AppSessionTrustedContext, value: unknown) => Promise<unknown>
        >
      )[definition.method];
      if (!method)
        throw new SessionControlError("unavailable", "Session control capability is unavailable.");
      return definition.output.parse(await method(trusted, parsed));
    },
  };
}

/** 独立 CLI 注册的 8 个会话工具（同名两种 surface 中只取 CLI 变体）。 */
export const sessionControlTools: readonly ToolEntry[] = cliSessionControlToolContracts.map(
  (definition) => createEntry("cli", definition),
);
/** Desktop Host 会话在 appControlEnabled 时注册的 12 个 App 工具（共有 8 个另加 4 个 App 专属）。 */
export const appSessionControlTools: readonly ToolEntry[] = appSessionControlToolContracts.map(
  (definition) => createEntry("app", definition),
);
export const CLI_SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(
  sessionControlTools.map((entry) => entry.metadata.name),
);
export const APP_SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(
  appSessionControlTools.map((entry) => entry.metadata.name),
);
/** 两种 surface 的全部名字：注册门按可信绑定选择唯一变体，缺席即不注册。 */
export const SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CLI_SESSION_CONTROL_TOOL_NAMES,
  ...APP_SESSION_CONTROL_TOOL_NAMES,
]);
/** 可信装配选出的一侧；同名工具不并存，避免模型看到两份实现。 */
export const sessionControlToolsByKind: Readonly<Record<"cli" | "app", readonly ToolEntry[]>> = {
  cli: sessionControlTools,
  app: appSessionControlTools,
};
