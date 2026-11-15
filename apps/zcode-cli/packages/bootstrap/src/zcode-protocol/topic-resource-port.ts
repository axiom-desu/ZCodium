import { randomUUID } from "node:crypto";
import type { TopicResourcePort } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeTopicResourceCancelResultSchema,
  zcodeTopicResourceReadResultSchema,
} from "@zcode/shared";
import { protocolTraceFromTraceContext, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const RESOURCE_TIMEOUT_MS = 120_000;

/**
 * CLI 侧唯一入口：把「当前任务 + 资源索引」交给 Host 的 bot 接纳归档，
 * 由 Host 下载并经 v4 附件通道寄存回本进程，返回受管 ref。
 *
 * 模型输入不能指定 URL、路径、群或会话；taskId 来自工具运行上下文。
 */
export function createProtocolTopicResourcePort(
  context: ZCodeProtocolAgentServerContext,
): TopicResourcePort {
  return {
    async read(request, options) {
      options.signal.throwIfAborted();
      const requestId = randomUUID();
      // 原因：Core trace 含 sessionId 等额外字段，原样发送会让 Host 严格校验失败。
      const trace = options.trace ? protocolTraceFromTraceContext(options.trace) : undefined;
      const cancel = async () => {
        try {
          await context.requestClient(
            zcodeProtocolMethods.topicResourceCancel,
            { requestId, taskId: request.taskId },
            zcodeTopicResourceCancelResultSchema,
            { timeoutMs: RESOURCE_TIMEOUT_MS, ...(trace ? { trace } : {}) },
          );
        } catch {
          // 取消是尽力通知：断连时 requestClient 会同步抛错，不能从 abort listener 冒泡。
          // 原始读取仍保留取消/断连错误，不重连、不重试。
        }
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await context.requestClient(
          zcodeProtocolMethods.topicResourceRead,
          {
            requestId,
            taskId: request.taskId,
            ...(request.inputId ? { inputId: request.inputId } : {}),
            messageId: request.messageId,
            resourceIndex: request.resourceIndex,
          },
          zcodeTopicResourceReadResultSchema,
          { signal: options.signal, timeoutMs: RESOURCE_TIMEOUT_MS, ...(trace ? { trace } : {}) },
        );
        options.signal.throwIfAborted();
        return result;
      } finally {
        options.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
