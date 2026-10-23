// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
//
// 结构：binder 只剩「组装」。命令入口（coreHost 的 admission / 行定位 / 会话操作）、
// 事件转发（notify + config/index 种子）、传输编解码（attachment / file changes /
// dwf 读面 / 命令事实查询）、冷恢复衔接（loadPersistedEvents）各自在 v4-bridge-*
// 模块里用显式 ports 组装；gateway 仍是 subscription/frame 的唯一 owner，本轮不迁移状态。
import { activateSessionForResume } from "./server-operations.js";
import { loadPersistentCommandFacts } from "../zcode-protocol-v4/persistent-command-facts.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionId } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { createProtocolLogger, type ZCodeProtocolAgentServerContext } from "./server-types.js";
import { createV4AutoDrain } from "./v4-bridge-auto-drain.js";
import { createCommandEntryAdmission } from "./v4-bridge-command-entry-admission.js";
import { createCommandEntryLookups } from "./v4-bridge-command-entry-lookups.js";
import { createCommandEntryRowResolution } from "./v4-bridge-row-resolution.js";
import { createCommandEntrySessionOps } from "./v4-bridge-session-ops.js";
import { createGatewayEventForwarding } from "./v4-bridge-event-forwarding.js";
import { createGatewayColdHydration } from "./v4-bridge-hydration.js";
import { createGatewayTransportCodec } from "./v4-bridge-transport-codec.js";
import { createStoredSessionSummaries } from "./v4-bridge-summaries.js";
import type { V4BridgeBasePorts, V4BridgeRuntimePorts } from "./v4-bridge-shared.js";

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });

  const basePorts: V4BridgeBasePorts = { context, log, persistentCommands };
  const autoDrain = createV4AutoDrain({ ...basePorts, getNativeExecutor: () => nativeExecutor });
  const autoDrainV4QueueIfReady = autoDrain.autoDrainV4QueueIfReady;
  const summaries = createStoredSessionSummaries(basePorts);
  // 同一注册表实例：admission 只透传同一 record 引用，不产生第二份会话事实。
  const coreHost: V4CommandCoreHost = {
    ...createCommandEntryLookups(basePorts),
    ...createCommandEntryAdmission(basePorts),
    ...createCommandEntryRowResolution(basePorts),
    ...createCommandEntrySessionOps({ ...basePorts, autoDrain }),
  };
  let nativeExecutor: V4CommandExecutor;
  nativeExecutor = new V4CommandExecutor(coreHost);
  const runtimePorts: V4BridgeRuntimePorts = {
    ...basePorts,
    coreHost,
    autoDrain,
    summaries,
    getNativeExecutor: () => nativeExecutor,
  };
  // 帧发射 / config 种子 / sessions-index / 传输编解码 / 冷恢复各段都只读同一 context，
  // 按固定顺序展开：后面的段不覆盖前面的键（键集合互不相交）。
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    sessionExists: (sessionId) => context.sessions.has(sessionId),
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    // Gateway 的单一 READY promise 负责并发与水位；binder 只恢复 runtime。
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: ZCodeWorkspaceRef,
    ) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!persisted) {
        context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const activated = await activateSessionForResume(
        context,
        {
          sessionId,
          // session.path 可能是规范化后的执行 cwd，不能覆盖当前 attachment
          // 已知的 workspace 身份。旧 session 没有 attachment 上下文时仍走原有持久化回退。
          ...(workspace ? { workspace } : {}),
          ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
        },
        { reusePersistedMessages: true },
      );
      return {
        status: "resumed",
        persistedMessages: activated.persistedMessages,
      };
    },
    ...createGatewayEventForwarding(runtimePorts),
    ...createGatewayTransportCodec(runtimePorts),
    ...createGatewayColdHydration(runtimePorts),
    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}
