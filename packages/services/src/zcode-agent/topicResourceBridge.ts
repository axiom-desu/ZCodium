import {
  zcodeTopicResourceCancelParamsSchema,
  zcodeTopicResourceReadParamsSchema,
  zcodeTopicResourceReadResultSchema,
  type ZCodeProtocolTrace,
  type ZCodeTopicResourceReadParams,
  type ZCodeTopicResourceReadResult,
} from "@zcode/shared";

const TOPIC_RESOURCE_REQUEST_TIMEOUT_MS = 120_000;

interface TopicResourceBridgeDependencies {
  validate(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<void>;
  /** 已由 bot 服务按接纳快照下载的字节；不回传本地路径。 */
  read(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<{ fileName: string; mime: string; bytes: Uint8Array }>;
  /** 经现有 v4 附件通道寄存到目标 CLI，返回 CLI 侧受管 ref。 */
  upload(
    request: ZCodeTopicResourceReadParams,
    payload: { fileName: string; mime: string; bytes: Uint8Array },
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<{ ref: string; bytes: number }>;
}

/**
 * 每条实际 CLI 连接拥有独立取消域：不能取消另一窗口、另一 workspace 或另一任务的读取。
 * pending 只保存取消句柄，不缓存字节，也不构成第二份任务队列。
 */
export function createTopicResourceBridge(deps: TopicResourceBridgeDependencies) {
  const pending = new Map<string, { taskId: string; controller: AbortController }>();
  let disposed = false;
  return {
    async read(value: unknown, trace?: ZCodeProtocolTrace): Promise<ZCodeTopicResourceReadResult> {
      const request = zcodeTopicResourceReadParamsSchema.parse(value);
      if (disposed) throw new Error("Topic resource connection is closed");
      if (pending.has(request.requestId)) {
        throw new Error("Topic resource request is already active");
      }
      const controller = new AbortController();
      pending.set(request.requestId, { taskId: request.taskId, controller });
      const timer = setTimeout(
        () => controller.abort(new Error("Topic resource request timed out")),
        TOPIC_RESOURCE_REQUEST_TIMEOUT_MS,
      );
      try {
        // 下载前复核授权：停用/换绑/过期在请求到达时就必须拒绝，而不是下载完再判断。
        await deps.validate(request, controller.signal, trace);
        controller.signal.throwIfAborted();
        const payload = await deps.read(request, controller.signal, trace);
        controller.signal.throwIfAborted();
        if (payload.bytes.byteLength === 0) throw new Error("Topic resource is empty");
        const uploaded = await deps.upload(request, payload, controller.signal, trace);
        controller.signal.throwIfAborted();
        // 传输期间群可能被停用；返回引用前再核对一次，不暴露已失效请求的文件。
        await deps.validate(request, controller.signal, trace);
        controller.signal.throwIfAborted();
        return zcodeTopicResourceReadResultSchema.parse({
          ref: uploaded.ref,
          fileName: payload.fileName,
          mime: payload.mime,
          bytes: payload.bytes.byteLength,
        });
      } finally {
        clearTimeout(timer);
        pending.delete(request.requestId);
      }
    },
    cancel(value: unknown): boolean {
      const parsed = zcodeTopicResourceCancelParamsSchema.safeParse(value);
      if (!parsed.success) return false;
      const operation = pending.get(parsed.data.requestId);
      if (!operation || operation.taskId !== parsed.data.taskId) return false;
      operation.controller.abort(new Error("Topic resource request cancelled"));
      return true;
    },
    dispose(): void {
      disposed = true;
      for (const operation of pending.values()) {
        operation.controller.abort(new Error("Topic resource connection closed"));
      }
      pending.clear();
    },
  };
}
