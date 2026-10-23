import { buildColdFileChangeSummaries } from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import type { SessionId } from "@zcode/contracts";
import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";
import { listSessionSubagents, readSessionContextUsage } from "./server-operations.js";
import type { V4BridgeRuntimePorts, V4GatewayOptions } from "./v4-bridge-shared.js";
import {
  replayDynamicWorkflowRunEvents,
  resolveConversationBackingRecord,
  sessionUsageSeedFromRuntimeContextUsage,
} from "./v4-bridge-cold-hydration.js";

export function createGatewayColdHydration(
  ports: V4BridgeRuntimePorts,
): Pick<V4GatewayOptions, "loadPersistedEvents"> {
  const context = ports.context;
  const log = ports.log;
  return {
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // dwf workflow actor / subagent 这类 detached live child 没有自己的
      // bootstrap record（事件经 ingestDetachedLiveSession 走父 record 的 sink 路由）。
      // context.sessions.get 取不到 record 时不能直接返回 synthesized:false——
      // 否则首次订阅的 performHydration 会走"保留健康 live publisher"早退分支，
      // durable transcript 三源合并从不执行——只由 live 事件喂养的投影会丢掉所有
      // 不以 live 事件形式出现的持久正文。amend-resume 把前驱 transcript 前缀直接
      // 复制进 session store 来播种 actor 会话，
      // 这段前缀正属于此类，于是侧栏 actor transcript 只剩本次 live 增量；
      // 普通崩溃恢复后 warm 窗口同样看不到 crash 前的 actor 消息。
      // 改用 resolveConversationBackingRecord：child 自身没有 record 时按持久
      // parentID 落到父 record，只借它的共享 event/artifact store，事件读取仍显式用
      // child 自己的 sessionId（script workflow child runtime 共享父 event store，
      // 事件按 child sessionId 归档），因此 sourceEventSeq 仍是 child 的真实水位。
      // 代价：contextWindow 分母会按父 record 的当前模型解析而不是 actor 模型，纯展示层偏差。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // 诊断：hydrate 预期在 runtime 已由 cold-resume 激活后执行；连父 record 兜底
        // 都落空时，返回空事件会把真实的生命周期竞态伪装成“历史为空”，必须留下明确现场。
        context.logger?.warn("ZCode Protocol v4 hydrate has no active runtime", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.hydrate_runtime_missing",
          module: "bootstrap.zcode_protocol",
          phase: "loadPersistedEvents",
          sessionId,
        });
        return { events: [], synthesized: false, sourceEventSeq: 0 };
      }
      // message/part 与 session_entry 的异步读取期间 live sink 仍可收到新事件。
      // gateway 必须知道 memory eventStore 取快照时的 raw cursor，才能只补 await 窗口内
      // 的尾部，并把 transcript 合成的 1..N 序列稳定映射回后续 runtime raw seq。
      // 内存 event store 会淘汰已完成 turn 的瞬态事件，max(events.seq) 会小于真实
      // 游标，让已淘汰的 delta 被当成 await 窗口尾部重放。两次调用之间没有 await，拿到的是
      // 同一时刻的一致快照。
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges 只存在于内存事件；cold merge 以持久
      // transcript 为正文权威时会压掉该事件，而 transcript 本身没有文件摘要字段。
      // workspace checkpoint + artifact 才是跨进程持久事实，这里按 user messageId
      // 重建摘要，再交给 transcript hydration 合成同构 ModelComplete。
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // 冷恢复 transcript 不保存模型能力，旧 hydration 自行填 20 万；
      // provider registry 已在 resume 前同步完成，应按恢复/退避后的当前模型精确取值。
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // transcript 可恢复 Agent row，却不能证明 child session 已经落库。
      // 这里在 gateway 的 raw-event buffer 补回前生成校验种子，既排除旧幽灵引用，
      // 又避免异步查询覆盖 seed 之后新到达的 live spawn/stop。
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // 与合成事件共用本次查询结果；不在后续回填阶段重新读取另一份容量。
        usageSeed,
        // gateway 旧字段名仍叫 synthesized；这里表示投影已由 durable
        // transcript 重物化，需替换 ingest 抢先建的 cold publisher。
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
  };
}
