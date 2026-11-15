import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import {
  IBotsService,
  IGenUiService,
  IMcpSyncService,
  ISettingService,
  IZCodeAgentService,
  type ServiceCollection,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
  WEB_REMOTE_BOTS_ALLOWED_METHODS,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  // 仅保留原终端服务面；页面 owner 与 attachment 生命周期不同，不能在此引入换代回收。
  ServiceChannels.Terminal,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  // 继续使用 Host 已构造的分享 attachment wrapper，不发布 raw service。
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  // 手机没有同步 UI 不等于 RPC 没有写入能力；SkillSync/PluginSync 不发布。
  // MCP 同频道混有现用设置方法，须再按方法收窄。
  ServiceChannels.McpSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.PromptAttachmentTransfer,
]);

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

/**
 * 浏览器完整 Web 客户端：第一方产物 + 已配对 Cookie，界面上真实存在这些页面。
 * 与手机子集的差别只在「Web 客户端确实会调用」的频道；仍然拒绝窗口/设备/凭据写面，
 * 未审阅频道（含 override）继续默认不发布。
 */
const WEB_CLIENT_ALLOWED_CHANNELS = new Set<string>([
  ...WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
  // 设置页与插件排序/筛选读取 UI 偏好。
  ServiceChannels.ClientConfig,
  // Web 端有完整的技能/插件同步与 Gen UI 面板。
  ServiceChannels.SkillSync,
  ServiceChannels.PluginSync,
  // Gen UI 没有独立 ServiceChannels 常量，按服务描述符取名，避免手写字符串分叉。
  IGenUiService.channelName,
]);

const WEB_CLIENT_EXPOSURE_POLICY: ServiceExposurePolicy = {
  // WindowController 属桌面窗口操作；ProviderProvisioningTarget 与 SourceServerManagement
  // 携带本机凭据/设备管理，浏览器不发布。
  allowedChannels: new Set(
    [...WEB_CLIENT_ALLOWED_CHANNELS].filter(
      (channel) =>
        channel !== ServiceChannels.WindowController &&
        channel !== ServiceChannels.ProviderProvisioningTarget &&
        channel !== ServiceChannels.SourceServerManagement,
    ),
  ),
};

function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
  surface: "mobile" | "web-client" = "mobile",
): ServiceExposurePolicy | undefined {
  // 过去手机共用完整服务集合，新增管理/provisioning 频道会自动开放；显式 allowlist 默认拒绝。
  // desktop-continuous 不加 policy，完整服务面与既有 attachment 包装保持不变。
  if (clientMode !== "web-remote-replayable") return undefined;
  return surface === "web-client"
    ? WEB_CLIENT_EXPOSURE_POLICY
    : WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY;
}

const MOBILE_MCP_SYNC_ALLOWED_METHODS = new Set<string>([
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "listWorkspaceMcpServerStatuses",
] satisfies ReadonlyArray<keyof IMcpSyncService>);

/**
 * Bug 原因：远程 attachment 直接发布完整 Setting/ZCodeAgent 服务，新增的
 * `getUserInstructions/saveUserInstructions` 与 `setWorkspaceMcpTrust` 会被配对手机直接调用，
 * 造成持久化提示注入与任意工作区信任写入。修复依据见
 * `.agents/specs/upstream-3.18-security-hardening.md`（B2）：频道内再按方法收窄，
 * Setting 使用白名单让未来新方法默认拒绝；Agent 只拒绝明确的 trust 方法，保留手机既有事件面。
 */
const MOBILE_SETTING_ALLOWED_METHODS = new Set<string>([
  "get",
  "update",
  "updateDataBaseDir",
  "ensureDefaultProject",
] satisfies ReadonlyArray<keyof ISettingService>);

const MOBILE_ZCODE_AGENT_DENIED_METHODS = new Set<string>([
  "setWorkspaceMcpTrust",
] satisfies ReadonlyArray<keyof IZCodeAgentService>);

/**
 * 手机/Web attachment 只发布 Bot 管理与读取面；未来新增方法默认拒绝。
 *
 * 原因：Bots 通道过去以完整服务面发布。`readTopicResource`/`validateTopicResource` 是
 * Host 反向 RPC 的字节下载入口，`handleProviderCallback*`/`handleInboundMessage` 是只有
 * 受信 provider 回调与桥接才可调用的入站面；任意配对客户端直接调用就绕过 CLI 任务归属、
 * 工具权限与 callback 鉴权。收窄白名单而不是逐条拒绝，保证以后新增的 Bots 方法不会自动开放。
 */
const MOBILE_BOTS_ALLOWED_METHODS = new Set<string>(WEB_REMOTE_BOTS_ALLOWED_METHODS);

function rejectRemoteMethod(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("Remote sync is only available from Desktop"), {
      kind: "feature_disabled" as const,
    }),
  );
}

function scopeMcpSyncServiceForMobile(service: IMcpSyncService): IMcpSyncService {
  return scopeServiceMethods(service, MOBILE_MCP_SYNC_ALLOWED_METHODS);
}

/** 只发布白名单方法面；未来新增方法默认拒绝。 */
function scopeServiceMethods<T extends object>(
  service: T,
  allowed: ReadonlySet<string>,
  options?: { keepEvents?: boolean },
): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      if (typeof key !== "string" || key === "then") return undefined;
      if (/^on[A-Z]/.test(key)) {
        // Setting 的 onDidChange 是既有 RPC 事件；方法白名单不能连带切断订阅。
        if (!options?.keepEvents) return undefined;
        const event = service[key as keyof T];
        return typeof event === "function" ? event.bind(service) : event;
      }
      if (!allowed.has(key)) return rejectRemoteMethod;
      const method = service[key as keyof T] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
    },
  });
}

/** 只拒绝明确列出的方法；事件与其余既有方法保持原绑定。 */
function denyServiceMethodsForRemote<T extends object>(service: T, denied: ReadonlySet<string>): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      if (typeof key !== "string" || key === "then") return undefined;
      if (denied.has(key)) return rejectRemoteMethod;
      const value = service[key as keyof T];
      return typeof value === "function" ? value.bind(service) : value;
    },
  });
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  /** 未声明按手机子集，与旧客户端完全兼容。 */
  surface?: "mobile" | "web-client";
}): void {
  const { server, services, clientMode } = params;
  let overrides = params.overrides;
  if (clientMode === "web-remote-replayable") {
    // 只收窄本 attachment 的 override，不改共享集合或调用方 map，避免污染桌面 attachment。
    const scopedOverrides = new Map(overrides);
    const mcpSync =
      (scopedOverrides.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
      services.getOptional(IMcpSyncService);
    if (mcpSync) {
      scopedOverrides.set(IMcpSyncService.channelName, scopeMcpSyncServiceForMobile(mcpSync));
    }
    const setting =
      (scopedOverrides.get(ISettingService.channelName) as ISettingService | undefined) ??
      services.getOptional(ISettingService);
    if (setting) {
      // 个性化指令写入会落到 Host 的 ~/.zcodium/AGENTS.md，远程必须按白名单拒绝。
      scopedOverrides.set(
        ISettingService.channelName,
        scopeServiceMethods(setting, MOBILE_SETTING_ALLOWED_METHODS, { keepEvents: true }),
      );
    }
    const agent =
      (scopedOverrides.get(IZCodeAgentService.channelName) as IZCodeAgentService | undefined) ??
      services.getOptional(IZCodeAgentService);
    if (agent) {
      // Agent 通道也能直接调 trust 方法，不能只靠 McpSync 的方法收窄。
      scopedOverrides.set(
        IZCodeAgentService.channelName,
        denyServiceMethodsForRemote(agent, MOBILE_ZCODE_AGENT_DENIED_METHODS),
      );
    }
    const bots =
      (scopedOverrides.get(IBotsService.channelName) as IBotsService | undefined) ??
      services.getOptional(IBotsService);
    if (bots) {
      // 话题资源字节与 bot 入站回调只允许 Host 内部/受信 provider 调用，
      // 不能成为配对手机或 Web 客户端的直接下载/注入入口。
      scopedOverrides.set(
        IBotsService.channelName,
        scopeServiceMethods(bots, MOBILE_BOTS_ALLOWED_METHODS),
      );
    }
    overrides = scopedOverrides;
  }
  services.exposeOnChannelServer(
    server,
    overrides,
    resolveWindowHostServiceExposurePolicy(clientMode, params.surface ?? "mobile"),
  );
  if (clientMode === "web-remote-replayable") {
    const genUi =
      (overrides?.get(IGenUiService.channelName) as IGenUiService | undefined) ??
      services.getOptional(IGenUiService);
    if (genUi) {
      // 手机发送前需 listState，只开放原 owner 的只读上下文，不连带发布 sandbox/文件/写入面。
      server.registerChannel(
        IGenUiService.channelName,
        // 普通对象会继承 constructor/toString，ProxyChannel 按属性取方法时也能调用；无原型投影才是单方法面。
        ProxyChannel.fromService(
          Object.assign(Object.create(null), { listState: genUi.listState.bind(genUi) }),
        ),
      );
    }
  }
}
