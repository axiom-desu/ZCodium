import {
  SessionControlError,
  type AppSessionControl,
  type AppTrustedContext,
  type SessionControlErrorCode,
} from "@zcode/session-control/contracts";
import type { CapabilityInput, ExtensionErrorCode } from "@zcode/shared/extension-host";
import type { AppControlServiceHandle } from "#src/app-control/index.js";

/**
 * 能力后端分派：只调用 Host 现有服务的只读投影与会话 facade，不新增业务 owner。
 * 表里没有的能力在前面已被网关拒绝；这里的 default 只是防御，不静默降级。
 *
 * 会话能力（E8）复用既有 AppControlService.bindClient 的十二个意图：
 * 身份、代际与取消由网关/本模块注入，插件参数不能提供身份、权限或 bypass。
 * 不直接读 Repo、不直接操作 runtime、不创建第二 session/task owner。
 */
interface CapabilityDispatchCall {
  /** 网关认证后的插件身份；body 自报的 pluginId 已在此前核对过。 */
  pluginId: string;
  /** 本次调用到达的扩展进程代际；绑定与迟到结果都按它 fence。 */
  generation: number;
  capabilityId: string;
  /** 已由能力表 schema 解析的输入；仍会被 facade 再校验一次。 */
  input: unknown;
  signal: AbortSignal;
}

interface SessionDispatchOptions {
  appControl: AppControlServiceHandle;
  /** 撤销/停止/换代后为 false；由 adapters/service 的现有 owner 判定，不另存授权状态。 */
  isCurrent(pluginId: string, generation: number): boolean;
}

interface CapabilityDispatchOptions {
  readSettings(): Promise<{ locale: string }>;
  readProjects?(): Promise<Array<{ id: string; name: string }>>;
  workspaceIdentity(): string | null;
  currentRevision(): number;
  /** 没有装配 App 控制的 Host（非桌面本地、旧 Host）保持缺省拒绝。 */
  sessions?: SessionDispatchOptions;
}

/** 后端确定的失败原因：网关按 code 回给扩展，不把底层错误文本交给插件。 */
export class CapabilityDispatchError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityDispatchError";
  }
}

/** session-control 错误码按名映射；没有对应扩展错误码的归 backend-error。 */
const SESSION_CONTROL_ERROR_CODES: Partial<Record<SessionControlErrorCode, ExtensionErrorCode>> = {
  invalid_input: "invalid-input",
  forbidden: "forbidden",
  unavailable: "unavailable",
  conflict: "conflict",
  cancelled: "canceled",
};

const SESSION_READ_CAPABILITIES = [
  "sessions.listProjects",
  "sessions.listSessions",
  "sessions.readSession",
  "sessions.waitSessions",
] as const;

const SESSION_WRITE_CAPABILITIES = [
  "sessions.createSession",
  "sessions.forkSession",
  "sessions.sendToSession",
  "sessions.interruptSession",
  "sessions.renameSession",
  "sessions.openSession",
  "sessions.setSessionArchived",
  "sessions.setSessionPinned",
] as const;

const SESSION_CAPABILITIES = [...SESSION_READ_CAPABILITIES, ...SESSION_WRITE_CAPABILITIES];

function isSessionCapability(capabilityId: string): boolean {
  return (SESSION_CAPABILITIES as readonly string[]).includes(capabilityId);
}

export function createCapabilityDispatcher(
  options: CapabilityDispatchOptions,
): (call: CapabilityDispatchCall) => Promise<unknown> {
  return async (call) => {
    if (call.signal.aborted)
      throw new CapabilityDispatchError("canceled", "Extension request was canceled.");
    switch (call.capabilityId) {
      case "settings.get": {
        const settings = await options.readSettings();
        return { locale: settings.locale };
      }
      case "projects.list": {
        if (!options.readProjects) return [];
        const projects = await options.readProjects();
        return projects.map((project) => ({ id: project.id, name: project.name }));
      }
      case "context.get":
        return {
          workspaceIdentity: options.workspaceIdentity() ?? "",
          revision: options.currentRevision(),
        };
      default:
        if (isSessionCapability(call.capabilityId)) return runSessionCall(options, call);
        throw new Error(`unsupported-capability:${call.capabilityId}`);
    }
  };
}

/**
 * 一次会话能力调用的完整绑定：
 *
 *   assertCurrent → bindClient（可信客户端上下文）→ control.<intent> → assertCurrent
 *
 * 撤销/停止会 abort signal，同时让代际判定失败；两者都在返回前复检，迟到结果不交给插件。
 */
async function runSessionCall(
  options: CapabilityDispatchOptions,
  call: CapabilityDispatchCall,
): Promise<unknown> {
  const sessions = options.sessions;
  if (!sessions) {
    throw new CapabilityDispatchError(
      "host-unavailable",
      "Session control is not available in this Host.",
    );
  }
  const assertCurrent = () => {
    if (call.signal.aborted)
      throw new CapabilityDispatchError("canceled", "Extension request was canceled.");
    if (!sessions.isCurrent(call.pluginId, call.generation)) {
      throw new CapabilityDispatchError(
        "stale-generation",
        "Extension session binding is no longer current.",
      );
    }
  };
  assertCurrent();
  try {
    const context = await sessions.appControl.service.bindClient({
      kind: "client",
      // clientId 跨代际稳定（归因）；connectionId 每代际不同，是 fence。
      clientId: `extension:${call.pluginId}`,
      connectionId: `extension-host:${call.generation}:${call.pluginId}`,
      sourceServerId: sessions.appControl.sourceServerId,
      signal: call.signal,
      assertCurrent,
    });
    const result = await runSessionIntent(
      sessions.appControl.service.control,
      call.capabilityId,
      context,
      call.input,
    );
    assertCurrent();
    return result;
  } catch (error) {
    if (error instanceof CapabilityDispatchError) throw error;
    if (error instanceof SessionControlError) {
      const code = SESSION_CONTROL_ERROR_CODES[error.code] ?? "backend-error";
      throw new CapabilityDispatchError(code, error.message);
    }
    // 原始错误文本可能带路径或远端地址：只保留固定文案。
    throw new CapabilityDispatchError("backend-error", "Session control failed.");
  }
}

/**
 * 能力 id → 既有 App 意图。输入已在网关按能力表 schema 解析，并由 facade 再校验；
 * 这里的类型断言只是把 unknown 交回 canonical 输入类型，不改变校验边界。
 */
function runSessionIntent(
  control: AppSessionControl,
  capabilityId: string,
  context: AppTrustedContext,
  input: unknown,
): Promise<unknown> {
  switch (capabilityId) {
    case "sessions.listProjects":
      return control.listProjects(context, input as CapabilityInput<"sessions.listProjects">);
    case "sessions.listSessions":
      return control.listSessions(context, input as CapabilityInput<"sessions.listSessions">);
    case "sessions.readSession":
      return control.readSession(context, input as CapabilityInput<"sessions.readSession">);
    case "sessions.waitSessions":
      return control.waitSessions(context, input as CapabilityInput<"sessions.waitSessions">);
    case "sessions.createSession":
      return control.createSession(context, input as CapabilityInput<"sessions.createSession">);
    case "sessions.forkSession":
      return control.forkSession(context, input as CapabilityInput<"sessions.forkSession">);
    case "sessions.sendToSession":
      return control.sendToSession(context, input as CapabilityInput<"sessions.sendToSession">);
    case "sessions.interruptSession":
      return control.interruptSession(
        context,
        input as CapabilityInput<"sessions.interruptSession">,
      );
    case "sessions.renameSession":
      return control.renameSession(context, input as CapabilityInput<"sessions.renameSession">);
    case "sessions.openSession":
      return control.openSession(context, input as CapabilityInput<"sessions.openSession">);
    case "sessions.setSessionArchived":
      return control.setSessionArchived(
        context,
        input as CapabilityInput<"sessions.setSessionArchived">,
      );
    case "sessions.setSessionPinned":
      return control.setSessionPinned(
        context,
        input as CapabilityInput<"sessions.setSessionPinned">,
      );
    default:
      throw new CapabilityDispatchError(
        "unknown-capability",
        "Unknown extension session capability.",
      );
  }
}
