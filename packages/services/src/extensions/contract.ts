import type { Event } from "@zcode/rpc";
import type {
  ExtensionGrant,
  ExtensionSlotProjection,
  ExtensionProtocols,
} from "@zcode/shared/extension-host";
import { createServiceDescriptor } from "../descriptors.js";
import { ServiceChannels } from "@zcode/shared";

/**
 * 扩展宿主的唯一服务 owner：授权记录、能力网关、槽位投影与 loopback 服务器都在这里。
 * Renderer 只读投影；Main 只负责扩展进程生命周期；扩展进程只经 loopback 调用能力。
 */
export interface ExtensionPluginState {
  pluginId: string;
  name: string;
  version: string;
  declared: ExtensionGrant[];
  granted: ExtensionGrant[];
  recorded: ExtensionGrant[];
  status: "granted" | "needs-consent" | "inactive";
  capabilities: string[];
  protocols: ExtensionProtocols;
  consentedAt?: number;
}

export interface ExtensionsSnapshot {
  /** 单调递增的投影修订号；每次授权/撤销/贡献/启停都递增。 */
  revision: number;
  /** 当前扩展进程代际；没有进程时为 0。旧代际的请求与贡献一律拒绝。 */
  generation: number;
  workspaceIdentity: string | null;
  phase: "stopped" | "starting" | "ready" | "error";
  error?: string;
  plugins: ExtensionPluginState[];
  slots: ExtensionSlotProjection[];
}

export interface GrantExtensionInput {
  pluginId: string;
  /** 必须等于清单当前声明的档位；对话框打开期间清单变化则视为过期请求。 */
  grants: ExtensionGrant[];
}

export interface IExtensionsService {
  getSnapshot(): Promise<ExtensionsSnapshot>;
  /** 请求 Main 拉起扩展进程；只有桌面本地 Host 注册此服务。 */
  start(): Promise<ExtensionsSnapshot>;
  stop(): Promise<ExtensionsSnapshot>;
  grant(input: GrantExtensionInput): Promise<ExtensionsSnapshot>;
  /** 撤销后取消在途调用，后续调用与旧代际贡献全部拒绝。 */
  revoke(pluginId: string): Promise<ExtensionsSnapshot>;
  onDidChange: Event<ExtensionsSnapshot>;
}

export const IExtensionsService = createServiceDescriptor<IExtensionsService>(
  ServiceChannels.Extensions,
);
