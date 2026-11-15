import type { TraceContext } from "../tracing/tracer.js";

/**
 * 当前任务已接纳话题资源的读取端口。
 *
 * 身份（taskId / workspace / 授权）由装配侧可信上下文补齐，不从模型输入解析；
 * 实现必须拒绝未接纳输入、跨任务、过期或换代后的快照。
 */
export interface TopicResourcePort {
  read(
    request: {
      /** 当前 CLI 会话 id；模型不能提供。 */
      taskId: string;
      /** 快照 inputId；缺省时由 Host 在任务已接纳输入中解析。 */
      inputId?: string;
      messageId: string;
      resourceIndex: number;
    },
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
}
