import type { AppSessionControl, AppTrustedContext } from "@zcode/session-control/contracts";
import type { ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";

/**
 * 一次可信调用共有的连接事实：代际 fence、所属 Host、取消与复验。
 *
 * `assertCurrent` 只核对**连接代际**，不核对项目版本；业务层不能用它替代 owner 的准入校验。
 */
export interface AppControlCallerConnection {
  connectionId: string;
  sourceServerId: string;
  signal: AbortSignal;
  /** 连接代际已变、已释放或授权已撤销时抛错（永远同步抛）。 */
  assertCurrent(): void;
}

/** 只由 Host 的活跃 CLI 连接构造；模型参数不能提供身份、权限或 bypass。 */
export interface AppControlBinding extends ZCodeAgentWorkspaceTarget, AppControlCallerConnection {
  callerSessionId: string;
  /** 发起方绑定的窗口（Electron `window:<id>`）；导航只按它路由，不接受模型自报。 */
  uiTarget?: string;
  turnId?: string;
  callId?: string;
}

/**
 * 可信的进程内客户端（例如扩展网关）。它没有根会话，所以没有 self_wait；
 * 业务层只知道「客户端」，不知道它来自哪个插件。
 */
export interface AppControlClientBinding extends AppControlCallerConnection {
  kind: "client";
  clientId: string;
  inputSource?: ConversationInputSource;
}

/**
 * App control 的唯一入口：`bind` 把连接事实变成可信上下文，`control` 是对外十二个意图。
 * 服务不持有项目/会话状态，每次调用都读既有 owner。
 */
export interface AppControlService {
  control: AppSessionControl;
  bind(binding: AppControlBinding): Promise<AppTrustedContext>;
  bindClient(binding: AppControlClientBinding): Promise<AppTrustedContext>;
}

/** 交给进程内可信组件（扩展网关）的句柄；不注册进 ServiceCollection，不在 RPC 频道上。 */
export interface AppControlServiceHandle {
  service: AppControlService;
  sourceServerId: string;
}
