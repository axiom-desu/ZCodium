import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import {
  IGenUiService,
  IMcpSyncService,
  type ServiceCollection,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
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

export function resolveWindowHostServiceExposurePolicy(
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

function scopeMcpSyncServiceForMobile(service: IMcpSyncService): IMcpSyncService {
  const rejectMobileSync = async (): Promise<never> => {
    throw Object.assign(new Error("Remote sync is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return new Proxy({} as IMcpSyncService, {
    get: (_target, key) => {
      // 只提供方法面；事件和 thenable 探测不能伪装成可调用同步方法。
      if (typeof key !== "string" || key === "then" || /^on[A-Z]/.test(key)) return undefined;
      if (!MOBILE_MCP_SYNC_ALLOWED_METHODS.has(key)) return rejectMobileSync;
      const method = service[key as keyof IMcpSyncService] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
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
    const mcpSync =
      (overrides?.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
      services.getOptional(IMcpSyncService);
    if (mcpSync) {
      // 仅收窄本 attachment 的 override，不改共享集合或调用方 map，避免污染桌面 attachment。
      overrides = new Map(overrides).set(
        IMcpSyncService.channelName,
        scopeMcpSyncServiceForMobile(mcpSync),
      );
    }
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
