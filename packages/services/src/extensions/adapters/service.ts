import { Emitter } from "@zcode/rpc";
import {
  EXTENSION_SHUTDOWN_TIMEOUT_MS,
  sortSlotProjections,
  type ExtensionGrant,
  type ExtensionGrantRecord,
  type ExtensionSlotProjection,
} from "@zcode/shared/extension-host";
import type { ExtensionsSnapshot, IExtensionsService } from "../contract.js";
import type { AppControlServiceHandle } from "#src/app-control/index.js";
import { createCapabilityGateway, type GatewayPorts } from "../app/gateway.js";
import { createExtensionCredentials } from "../app/credentials.js";
import { createCapabilityDispatcher } from "../app/dispatch.js";
import { createLifecycleQueue } from "../app/lifecycleQueue.js";
import { buildPluginStates } from "../app/projection.js";
import { decideGrant } from "../app/grantState.js";
import { createGrantStore } from "./grantStore.js";
import { createGrantView } from "./grantView.js";
import { discoverExtensions, type DiscoveredExtension } from "./discovery.js";
import { createExtensionViewServer, type ExtensionViewServer } from "./loopbackServer.js";
import {
  delay,
  startExtensionWithTimeout,
  type ExtensionsProcessSupervisor,
} from "./processSupervisor.js";

export type { ExtensionsProcessSupervisor } from "./processSupervisor.js";

export interface ExtensionsServiceOptions {
  grantsFilePath: string;
  pluginDir: string;
  /** 当前窗口 workspace 身份；缺失时拒绝启动（扩展是本地窗口能力）。 */
  workspaceIdentity(): string | null;
  processSupervisor: ExtensionsProcessSupervisor;
  readSettings(): Promise<{ locale: string }>;
  readProjects?(): Promise<Array<{ id: string; name: string }>>;
  /**
   * 既有 App 控制的进程内句柄（十二个意图的唯一 facade）。
   * 缺省时会话能力报 host-unavailable；不降级为直接读库，也不新建 session owner。
   */
  appControl?: AppControlServiceHandle;
  now?(): number;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface ExtensionsService extends IExtensionsService {
  dispose(): Promise<void>;
}

/**
 * 扩展服务：授权记录、能力网关、槽位投影与 loopback 服务器的唯一 owner。
 *
 * 事件顺序：
 *   start() → 加载清单 → generation+1 → 开 loopback → 仅启动已同意插件 → ready
 *   grant() → 校验声明 → 原子写授权文件 → 发布 → Host ready 时启动该插件
 *   revoke() → 取消在途 → 失效 token → 停止该插件进程 → 写文件成功后才发布
 *   stop()/窗口关闭 → 取消全部在途 → 关 loopback → 停止该代际进程 → 清空槽位
 */
export function createExtensionsService(options: ExtensionsServiceOptions): ExtensionsService {
  const store = createGrantStore({ filePath: options.grantsFilePath });
  const now = options.now ?? Date.now;
  const emitter = new Emitter<ExtensionsSnapshot>();
  let loaded: DiscoveredExtension[] = [];
  let records: ExtensionGrantRecord[] | null = null;
  let projectedSlots = new Map<string, ExtensionSlotProjection[]>();
  let generationCounter = 0;
  let activeGeneration = 0;
  let runningWorkspaceIdentity: string | null = null;
  /** 每个插件自己的 token；token → pluginId 是唯一的传输身份绑定。 */
  const credentials = createExtensionCredentials();
  let server: ExtensionViewServer | null = null;
  let phase: ExtensionsSnapshot["phase"] = "stopped";
  let error: string | undefined;
  let revision = 0;
  let stopRequested = false;
  const queue = createLifecycleQueue();
  /** 清单/记录的唯一解释入口；记录写入仍由本文件的 grantStore 负责。 */
  const grants = createGrantView({ loaded: () => loaded, records: () => records });
  const dispatch = createCapabilityDispatcher({
    readSettings: options.readSettings,
    ...(options.readProjects ? { readProjects: options.readProjects } : {}),
    workspaceIdentity: options.workspaceIdentity,
    currentRevision: () => revision,
    ...(options.appControl
      ? {
          sessions: {
            appControl: options.appControl,
            // 撤销/停止/换代后旧绑定立即失效；凭据仍必须属于同一插件。
            isCurrent: (pluginId, generation) =>
              activeGeneration === generation &&
              generation > 0 &&
              grants.consented(pluginId) &&
              credentials.has(pluginId),
          },
        }
      : {}),
  });

  const gateway = createCapabilityGateway(buildPorts());

  function buildPorts(): GatewayPorts {
    return {
      currentGeneration: () => activeGeneration,
      currentWorkspaceIdentity: () => options.workspaceIdentity(),
      authenticate: (token) => credentials.authenticate(token),
      consented: grants.consented,
      plugin: (pluginId) => {
        const extension = loaded.find((item) => item.manifest.id === pluginId);
        return extension ? grants.declaredPlugin(extension) : undefined;
      },
      granted: grants.grantedFor,
      onContribution: (pluginId, slots) => {
        // 网关入口已核对同意；这里再复检，撤销后的迟到贡献不能重新写回槽位。
        if (!grants.consented(pluginId)) {
          projectedSlots.delete(pluginId);
          return revision;
        }
        projectedSlots.set(
          pluginId,
          slots.filter((slot) => slot.generation === activeGeneration),
        );
        revision += 1;
        publish();
        return revision;
      },
      dispatch: (call) => dispatch(call),
    };
  }

  function snapshot(): ExtensionsSnapshot {
    return {
      revision,
      generation: activeGeneration,
      workspaceIdentity: options.workspaceIdentity(),
      phase,
      ...(error ? { error } : {}),
      plugins: buildPluginStates(loaded, records, grants.declaredPlugin),
      slots: sortSlotProjections([...projectedSlots.values()].flat()),
    };
  }

  function publish(): void {
    emitter.fire(snapshot());
  }

  async function ensureLoaded(): Promise<void> {
    if (records !== null) return;
    const discovery = await discoverExtensions(options.pluginDir);
    loaded = discovery.extensions;
    if (discovery.rejected.length > 0) {
      options.logger?.warn(
        `extension manifests rejected: ${discovery.rejected.map((item) => `${item.directory}:${item.code}`).join(",")}`,
      );
    }
    records = await store.load();
  }

  async function closeServer(): Promise<void> {
    const current = server;
    server = null;
    if (current) await current.close().catch(() => {});
  }

  async function stopGeneration(generation: number): Promise<void> {
    await Promise.race([
      options.processSupervisor.stop(generation).catch(() => {}),
      delay(EXTENSION_SHUTDOWN_TIMEOUT_MS),
    ]);
  }

  /** 工作区身份变化后旧代际的槽位与凭据必须立刻失效，不能投影到新工作区。 */
  function reconcileWorkspace(): void {
    if (activeGeneration === 0) return;
    if (options.workspaceIdentity() === runningWorkspaceIdentity) return;
    const staleGeneration = activeGeneration;
    activeGeneration = 0;
    runningWorkspaceIdentity = null;
    gateway.cancelAll();
    credentials.clear();
    projectedSlots = new Map();
    phase = "stopped";
    error = undefined;
    revision += 1;
    void closeServer();
    void stopGeneration(staleGeneration);
  }

  async function startPlugin(generation: number, extension: DiscoveredExtension): Promise<void> {
    const workspaceIdentity = runningWorkspaceIdentity;
    if (!server || !workspaceIdentity) throw new Error("Extension host is not ready.");
    const pluginId = extension.manifest.id;
    const token = credentials.issue(pluginId);
    try {
      await startExtensionWithTimeout(options.processSupervisor, {
        generation,
        workspaceIdentity,
        endpoint: server.url,
        token,
        pluginDir: extension.dir,
        pluginId,
      });
    } catch (cause) {
      credentials.revoke(pluginId);
      throw cause;
    }
  }

  async function abortStart(): Promise<void> {
    gateway.cancelAll();
    credentials.clear();
    const generation = activeGeneration;
    activeGeneration = 0;
    runningWorkspaceIdentity = null;
    await closeServer();
    projectedSlots = new Map();
    if (generation > 0) await stopGeneration(generation);
  }

  async function startInternal(): Promise<ExtensionsSnapshot> {
    reconcileWorkspace();
    if (stopRequested) return snapshot();
    if (phase === "ready" && activeGeneration > 0) return snapshot();
    phase = "starting";
    revision += 1;
    publish();
    try {
      await ensureLoaded();
      if (stopRequested) throw new Error("Extension host start was stopped.");
      const workspaceIdentity = options.workspaceIdentity();
      if (!workspaceIdentity) throw new Error("Extension host requires a workspace identity.");
      await closeServer();
      generationCounter += 1;
      const generation = generationCounter;
      activeGeneration = generation;
      runningWorkspaceIdentity = workspaceIdentity;
      credentials.clear();
      server = await createExtensionViewServer({
        authenticate: (token) => credentials.authenticate(token),
        gateway,
      });
      // 只启动用户已明确同意的插件；未同意的发现结果保持 needs-consent，不执行其 JS。
      for (const extension of loaded.filter(grants.isRunnable)) {
        if (stopRequested) throw new Error("Extension host start was stopped.");
        await startPlugin(generation, extension);
      }
      if (stopRequested) throw new Error("Extension host start was stopped.");
      phase = "ready";
      error = undefined;
      revision += 1;
      publish();
      return snapshot();
    } catch (cause) {
      await abortStart();
      phase = stopRequested ? "stopped" : "error";
      if (!stopRequested) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      revision += 1;
      publish();
      return snapshot();
    }
  }

  async function stopInternal(): Promise<ExtensionsSnapshot> {
    gateway.cancelAll();
    const stoppedGeneration = activeGeneration;
    activeGeneration = 0;
    runningWorkspaceIdentity = null;
    credentials.clear();
    await closeServer();
    projectedSlots = new Map();
    phase = "stopped";
    error = undefined;
    revision += 1;
    if (stoppedGeneration > 0) await stopGeneration(stoppedGeneration);
    stopRequested = false;
    publish();
    return snapshot();
  }

  async function grantInternal(input: {
    pluginId: string;
    grants: ExtensionGrant[];
  }): Promise<ExtensionsSnapshot> {
    await ensureLoaded();
    reconcileWorkspace();
    const extension = loaded.find((item) => item.manifest.id === input.pluginId);
    if (!extension) throw new Error("extension.not-found");
    const decision = decideGrant({
      declared: grants.declaredPlugin(extension),
      requested: input.grants,
      now: now(),
    });
    if (!decision.ok) throw new Error(`extension.${decision.code}`);
    const next = [
      ...(records ?? []).filter((item) => item.pluginId !== input.pluginId),
      decision.record,
    ];
    // 写入成功后才发布：保存失败不能留下「界面已授权、落盘未授权」的分叉。
    await store.save(next);
    records = next;
    revision += 1;
    publish();
    if (activeGeneration > 0 && !credentials.has(input.pluginId) && grants.isRunnable(extension)) {
      try {
        await startPlugin(activeGeneration, extension);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        revision += 1;
        publish();
      }
    }
    return snapshot();
  }

  async function revokeInternal(pluginId: string): Promise<ExtensionsSnapshot> {
    await ensureLoaded();
    reconcileWorkspace();
    gateway.cancelPlugin(pluginId);
    // 先失效传输凭据并停进程，撤销立刻生效；持久化失败时也不能继续接受该插件调用。
    credentials.revoke(pluginId);
    if (activeGeneration > 0) {
      await options.processSupervisor.stopPlugin(activeGeneration, pluginId).catch(() => {});
    }
    const next = (records ?? []).filter((item) => item.pluginId !== pluginId);
    try {
      await store.save(next);
    } catch (cause) {
      // 保存失败不发布撤回结果：运行时已 fail closed，投影保持上一次成功状态。
      options.logger?.warn("extension revoke persist failed");
      throw cause;
    }
    records = next;
    projectedSlots.delete(pluginId);
    revision += 1;
    publish();
    return snapshot();
  }

  return {
    async getSnapshot() {
      await ensureLoaded();
      reconcileWorkspace();
      return snapshot();
    },
    start: () => {
      stopRequested = false;
      return queue(startInternal);
    },
    stop: () => {
      stopRequested = true;
      // 不等待队列：正在 startup 的子进程也要立刻收到停止信号，避免 stop 卡在启动超时。
      if (activeGeneration > 0) {
        void options.processSupervisor.stop(activeGeneration).catch(() => {});
      }
      return queue(stopInternal);
    },
    grant: (input) => queue(() => grantInternal(input)),
    revoke: (pluginId) => queue(() => revokeInternal(pluginId)),
    onDidChange: emitter.event,
    async dispose() {
      try {
        await this.stop();
      } finally {
        emitter.dispose();
      }
    },
  };
}
