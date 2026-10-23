// v4 conversation 通道的命令入口/查询入口分派。这里只做「方法 → 网关能力」的
// 静态映射与 initial frame 交付；会话投影、序号与订阅表都在 gateway 内部。
import type { ZCodeProtocolRequest } from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import { getTaskTokenUsage, getUsageStats } from "./server-operations.js";
import {
  UNHANDLED_REQUEST,
  requireV4Gateway,
  type ProtocolRequestDispatchHost,
} from "./server-dispatch-types.js";

export async function dispatchV4Request(
  host: ProtocolRequestDispatchHost,
  request: ZCodeProtocolRequest,
): Promise<unknown | typeof UNHANDLED_REQUEST> {
  switch (request.method) {
    // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
    case V4_METHODS.connectionFlow: {
      requireV4Gateway(host).setConnectionFlowState(request.params);
      return {};
    }
    case V4_METHODS.conversationSubscribe: {
      // 同一 subscribe 方法按 topic 前缀分派：
      // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
      const gateway = requireV4Gateway(host);
      const topic = (request.params as { topic?: unknown } | null)?.topic;
      let dispatch;
      if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
        dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
      } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
        dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
      } else {
        dispatch = await gateway.subscribeReserved(request.params);
      }
      if (dispatch.initialWires.length > 0) {
        host.setPostResponseBatch(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationResync: {
      // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
      // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
      const dispatch = requireV4Gateway(host).resyncReserved(request.params);
      if (dispatch.initialWires.length > 0) {
        host.setPostResponseBatch(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationUnsubscribe: {
      // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
      // subId 对 conversation/sessions-index/workspace-config 广撒网。
      requireV4Gateway(host).unsubscribe(request.params);
      return {};
    }
    // ── 行分页 query（独立分支，便于与帧分派改动合并）──
    case V4_METHODS.conversationRowsRange:
      return await requireV4Gateway(host).rowsRange(request.params);
    case V4_METHODS.conversationPlans:
      return await requireV4Gateway(host).plans(request.params);
    case V4_METHODS.backgroundBashOutput:
      return await requireV4Gateway(host).backgroundBashOutput(request.params);
    case V4_METHODS.conversationFileChanges:
      return await requireV4Gateway(host).fileChanges(request.params);
    case V4_METHODS.conversationFileRewindPreview:
      return await requireV4Gateway(host).fileRewindPreview(request.params);
    // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
    case V4_METHODS.conversationWorkflowRunEvents:
      return await requireV4Gateway(host).workflowRunEvents(request.params);
    // dwf run 枚举（重启后的发现查询）。
    case V4_METHODS.conversationWorkflowRuns:
      return await requireV4Gateway(host).workflowRuns(request.params);
    // dwf 用户面产物的三个读面。同族：只读、无状态、
    // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
    case V4_METHODS.conversationWorkflowRunArtifacts:
      return await requireV4Gateway(host).workflowRunArtifacts(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactData:
      return await requireV4Gateway(host).workflowRunArtifactData(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactRead:
      return await requireV4Gateway(host).workflowRunArtifactRead(request.params);
    // dwf 工作区 transcript 的两个读面。同族。
    case V4_METHODS.conversationWorkflowRunWorkspace:
      return await requireV4Gateway(host).workflowRunWorkspace(request.params);
    case V4_METHODS.conversationWorkflowRunNodeResult:
      return await requireV4Gateway(host).workflowRunNodeResult(request.params);
    // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
    case V4_METHODS.attachmentBegin:
      return await requireV4Gateway(host).attachmentBegin(request.params);
    case V4_METHODS.attachmentChunk:
      return await requireV4Gateway(host).attachmentChunk(request.params);
    case V4_METHODS.attachmentCommit:
      return await requireV4Gateway(host).attachmentCommit(request.params);
    case V4_METHODS.attachmentAbort:
      await requireV4Gateway(host).attachmentAbort(request.params);
      return {};
    case V4_METHODS.attachmentRead:
      return await requireV4Gateway(host).attachmentRead(request.params);
    case V4_METHODS.conversationAttachmentRead:
      return await requireV4Gateway(host).conversationAttachmentRead(request.params);
    case V4_METHODS.conversationAttachmentStat:
      return await requireV4Gateway(host).conversationAttachmentStat(request.params);
    case V4_METHODS.attachmentPreviewSource:
      return await requireV4Gateway(host).attachmentPreviewSource(request.params);
    // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
    // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
    // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
    case V4_METHODS.usageStats:
      return await getUsageStats(host.context, request.params);
    case V4_METHODS.conversationUsage:
      return await getTaskTokenUsage(host.context, request.params);
    case V4_METHODS.command:
      return requireV4Gateway(host).handleCommand(request.params);
    case V4_METHODS.commandsQuery:
      return requireV4Gateway(host).queryCommands(request.params);
    default:
      return UNHANDLED_REQUEST;
  }
}
