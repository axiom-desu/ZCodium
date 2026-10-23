import {
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  logModelRequestMediaSummary,
  projectMessagesForInputFormat,
  projectMessagesForMediaBudget,
  projectMessagesWithMediaAttachmentPaths,
} from "../helpers/index.js";
import type { Model } from "../deps.js";
import type { RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Model 请求装配里的媒体投影步骤：artifact 路径 → 输入格式能力 → 媒体预算。
 *
 * 只读 artifactStore 与模型能力，返回新的请求 options；不写 runtime 状态、不发事件。
 * 工具入参/流事件仍由 `model.ts` 的请求编排拥有。
 */
export async function projectModelRequestInput(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
  model: Model,
): Promise<RunModelTextRequestOptions> {
  // 闲时 turn 只覆盖了父 runtime 的默认模型，foreground child 重新建
  // request 时仍读取 session 配置，导致 provider options/capability 与本轮模型分叉。
  // turn 快照存在时必须整体采用快照，不能用 `??` 回退到用户模型的字段。
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  return projectedOptions;
}
