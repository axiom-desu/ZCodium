import { Event as RpcEvent } from "@zcode/rpc";
import type { IConversationShareService, IZCodeAgentService } from "@zcode/services";
import { conversationShareConnectionScopeFactory } from "@zcode/services/node";

/**
 * 连接范围（connection scope）的唯一实现。
 *
 * 分享在 Desktop 只允许在当前 attachment 的可信 Agent scope 内读取 contents/file：
 * 手机远控（web-remote-replayable）没有本地 workspace 副本，只保留 capability 查询
 * 与「读回已导入副本」，其余入口一律拒绝，避免另起一套 Agent/会话。
 */
type ConversationShareAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "conversationFileChangesV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
>;

type ConnectionScopableConversationShareService = IConversationShareService & {
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService;
};

function isConnectionScopableConversationShareService(
  service: IConversationShareService,
): service is ConnectionScopableConversationShareService {
  return (
    conversationShareConnectionScopeFactory in service &&
    typeof service[conversationShareConnectionScopeFactory] === "function"
  );
}

export function scopeConversationShareServiceForAttachment(
  service: IConversationShareService,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  agentService?: ConversationShareAgentService,
): IConversationShareService {
  if (clientMode === "desktop-continuous") {
    if (!isConnectionScopableConversationShareService(service)) return service;
    if (agentService) return service[conversationShareConnectionScopeFactory](agentService);
    const rejectUnavailable = async (): Promise<never> => {
      throw Object.assign(new Error("Conversation sharing connection is not ready"), {
        kind: "connection_unavailable" as const,
      });
    };
    return {
      getCapabilities: () => service.getCapabilities(),
      canImport: async () => false,
      preflight: rejectUnavailable,
      publish: rejectUnavailable,
      readExportChunk: rejectUnavailable,
      releaseExport: async () => {},
      onDynamicPublishProgress: () => RpcEvent.None,
      beginArchiveImport: rejectUnavailable,
      appendArchiveImport: rejectUnavailable,
      releaseArchiveImport: async () => {},
      importShare: rejectUnavailable,
      onDynamicImportProgress: () => RpcEvent.None,
      getImportedConversation: (input) => service.getImportedConversation(input),
    };
  }
  const rejectMobileShare = async (): Promise<never> => {
    throw Object.assign(new Error("Conversation sharing is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return {
    getCapabilities: () => service.getCapabilities(),
    canImport: async () => false,
    preflight: rejectMobileShare,
    publish: rejectMobileShare,
    readExportChunk: rejectMobileShare,
    releaseExport: async () => {},
    onDynamicPublishProgress: () => RpcEvent.None,
    beginArchiveImport: rejectMobileShare,
    appendArchiveImport: rejectMobileShare,
    releaseArchiveImport: async () => {},
    importShare: rejectMobileShare,
    onDynamicImportProgress: () => RpcEvent.None,
    // 手机远控没有本地 workspace 副本，直接返回 null 即可（不渲染只读块）。
    getImportedConversation: async () => null,
  };
}
