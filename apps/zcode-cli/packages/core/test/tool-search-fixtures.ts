// ============================================================
// ToolSearch 测试夹具：把 runtime 侧构造收敛到一处
// ============================================================
// 只搭 ToolSearch 需要的那几样（模型能力、registry、消息投影），不构造真 AgentRuntime。

import type {
  Model,
  ModelInputMessage,
  ModelToolContract,
  RuntimeInputPresentation,
  ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ModelInputMessage as RuntimeModelInputMessage } from "../src/agent/message-history.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { ToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolMetadata } from "../src/tool/types.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import { resolveDeferredToolCall } from "../src/tool/deferred-call.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

export function toolEntry(name: string, extra: Partial<ToolMetadata> = {}): ToolEntry {
  return {
    metadata: {
      name,
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
      ...extra,
    },
  } as unknown as ToolEntry;
}

export function registryOf(
  entries: readonly ToolEntry[],
): Pick<ToolRegistry, "get" | "has" | "list"> {
  const map = new Map(entries.map((entry) => [entry.metadata.name, entry]));
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    list: () => [...map.keys()],
  };
}

function model(input: { protocolSupported: boolean; defaultEnabled?: boolean }): Model {
  return {
    modelId: "m",
    properties: {
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      supportsToolCall: true,
      supportsVision: false,
      supportsReasoning: false,
    },
    providerId: "p",
    requestCapabilities: {
      toolSearch: {
        defaultEnabled: input.defaultEnabled === true,
        protocolSupported: input.protocolSupported,
      },
    },
  } as unknown as Model;
}

export const nativeModel = () => model({ protocolSupported: true, defaultEnabled: true });
export const localModel = () => model({ protocolSupported: false });
export const modelOf = model;

export function buildExposure(input: {
  entries: readonly RuntimeMessageEntry[];
  mode: "auto" | "native" | "local" | "off";
  model?: Model;
  tools: readonly ModelToolContract[];
  registry: ReturnType<typeof registryOf>;
}) {
  return buildToolExposure({
    entries: input.entries,
    mode: input.mode,
    model: input.model ?? localModel(),
    registry: input.registry,
    tools: input.tools,
  });
}

export function buildModelRequestMessages(
  entries: readonly RuntimeMessageEntry[],
  mode: "auto" | "native" | "local" | "off",
): ModelInputMessage[] {
  const projection = buildProviderRequestMessages({
    entries: mode === "off" ? entries : [...entries],
  });
  return projection.messages;
}

export function buildWrapperCall(
  call: { id: string; input: unknown; name: string },
  context: ToolSearchExecutionContext,
  registry: Pick<ToolRegistry, "get">,
) {
  return resolveDeferredToolCall(call, context, registry);
}

export type FixtureMessage = RuntimeModelInputMessage;
export type FixturePresentation = RuntimeInputPresentation;
