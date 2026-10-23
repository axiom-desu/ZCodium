import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationRowsRangeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  BackgroundBashOutputResult,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { toRuntimeTurnId } from "./v4-gateway-contract.js";
import type { V4GatewayHost } from "./v4-gateway-contract.js";

/** 窄端口：rows/plans/文件摘要查询只读 readiness 解析结果与宿主文件能力。 */
interface FileQueryDeps {
  host: Pick<
    V4GatewayHost,
    "getConversationFileChanges" | "previewConversationFileRewind" | "readBackgroundBashOutput"
  >;
  /** 与 conversation subscribe 同一活性判定的 READY 解析。 */
  resolveLivePublisher(sessionId: string): Promise<ConversationTopicPublisher>;
  /** fileRewindPreview 的既有口径：按 record 是否存在决定冷恢复。 */
  resolveSessionPublisher(sessionId: string): Promise<ConversationTopicPublisher>;
}

export function createFileQueries(deps: FileQueryDeps) {
  const { host, resolveLivePublisher, resolveSessionPublisher } = deps;
  async function rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
    const publisher = await resolveLivePublisher(params.sessionId);
    return publisher.getRowsRange(
      {
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      },
      // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
      params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
    );
  }

  /** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
  async function plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    const params = v4ConversationPlansParamsSchema.parse(rawParams);
    const publisher = await resolveLivePublisher(params.sessionId);
    return publisher.getPlans();
  }

  async function fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
    if (!host.getConversationFileChanges) {
      throw new Error("fault.fileChanges.unsupported");
    }
    const publisher = await resolveLivePublisher(params.sessionId);
    const resolution = resolveQueryRowTarget(publisher, params, "fileChanges");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return host.getConversationFileChanges(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  async function backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
    // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
    if (!host.readBackgroundBashOutput) return { kind: "unsupported", workId };
    return backgroundBashOutputResultSchema.parse(
      await host.readBackgroundBashOutput(sessionId, workId),
    );
  }

  async function fileRewindPreview(
    rawParams: unknown,
  ): Promise<V4ConversationFileRewindPreviewResult> {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
    if (!host.previewConversationFileRewind) {
      throw new Error("fault.fileRewindPreview.unsupported");
    }
    const publisher = await resolveSessionPublisher(params.sessionId);
    const resolution = resolveQueryRowTarget(publisher, params, "fileRewindPreview");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return host.previewConversationFileRewind(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  function resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    const snapshot = publisher.getSnapshot();
    if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
    if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
    const resolution = publisher.resolveRowActionTarget(params.target, action);
    if (!resolution.ok) throw new Error(resolution.reasonCode);
    return resolution;
  }

  return { rowsRange, plans, fileChanges, backgroundBashOutput, fileRewindPreview };
}
