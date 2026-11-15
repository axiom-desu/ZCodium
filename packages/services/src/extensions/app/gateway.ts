import type {
  ExtensionCapabilityRequest,
  ExtensionCapabilityResponse,
  ExtensionContributionRequest,
  ExtensionContributionResponse,
  ExtensionErrorCode,
  ExtensionSlotProjection,
} from "@zcode/shared/extension-host";
import {
  getCapabilityDef,
  grantsCover,
  isProtocolCompatible,
  sortSlotProjections,
} from "@zcode/shared/extension-host";
import { admitCapability, type DeclaredPlugin } from "./grantState.js";
import { CapabilityDispatchError } from "./dispatch.js";

/**
 * 能力网关：唯一准入点。
 *
 * 顺序固定为「认证 transport → 绑定 pluginId → 代际 → 工作区 → 声明 → 协议 → 授权 → 后端」；
 * 撤销与停止在入口和返回两个时刻各复检一次，扩展写回旧代际或撤销后的结果一律丢弃
 * （canceled / stale-generation）。
 *
 * 身份只能来自已认证的 Bearer token：body 的 `pluginId` 只是待校验的声明，不能作为身份来源。
 */
export interface ExtensionTransportAuth {
  /** 已通过 loopback 认证的凭据原文；只在进程内使用，不写日志。 */
  token: string;
  /** 该凭据在服务内绑定的 pluginId。 */
  pluginId: string;
}

export interface GatewayPorts {
  currentGeneration(): number;
  currentWorkspaceIdentity(): string | null;
  /** 认证凭据并返回它绑定的 pluginId；未知/已撤销凭据返回 null。 */
  authenticate(token: string): string | null;
  /** 插件当前是否仍有用户运行同意；撤销后即使凭据尚未失效也不能贡献。 */
  consented(pluginId: string): boolean;
  plugin(pluginId: string): DeclaredPlugin | undefined;
  granted(pluginId: string): readonly import("@zcode/shared/extension-host").ExtensionGrant[];
  /** 后端执行现有服务或投影泵；signal 在撤销/停止时 abort。插件身份与代际由网关注入。 */
  dispatch(input: {
    pluginId: string;
    generation: number;
    capabilityId: string;
    input: unknown;
    signal: AbortSignal;
  }): Promise<unknown>;
  onContribution(pluginId: string, slots: ExtensionSlotProjection[]): number;
}

export interface CapabilityGateway {
  call(
    request: ExtensionCapabilityRequest,
    auth: ExtensionTransportAuth,
  ): Promise<ExtensionCapabilityResponse>;
  contribute(
    request: ExtensionContributionRequest,
    auth: ExtensionTransportAuth,
  ): Promise<ExtensionContributionResponse>;
  /** 撤销该插件在途调用；之后返回的结果不会影响投影。 */
  cancelPlugin(pluginId: string): void;
  cancelAll(): void;
}

const EMPTY = { ok: false as const, code: "unauthorized" as ExtensionErrorCode };

export function createCapabilityGateway(ports: GatewayPorts): CapabilityGateway {
  const inflight = new Map<string, Set<AbortController>>();

  function cancelPlugin(pluginId: string): void {
    const controllers = inflight.get(pluginId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    inflight.delete(pluginId);
  }

  function cancelAll(): void {
    for (const pluginId of inflight.keys()) cancelPlugin(pluginId);
  }

  /** 认证身份、代际、工作区与 body 声明必须同时成立；返回第一个失败原因。 */
  function staleReason(
    auth: ExtensionTransportAuth,
    request: { generation: number; workspaceIdentity: string; pluginId: string },
  ): ExtensionErrorCode | null {
    if (ports.authenticate(auth.token) !== auth.pluginId) return EMPTY.code;
    if (request.pluginId !== auth.pluginId) return EMPTY.code;
    if (!ports.consented(auth.pluginId)) return "not-granted";
    if (request.generation !== ports.currentGeneration() || request.generation === 0) {
      return "stale-generation";
    }
    if (ports.currentWorkspaceIdentity() !== request.workspaceIdentity) return "workspace-mismatch";
    return null;
  }

  async function call(
    request: ExtensionCapabilityRequest,
    auth: ExtensionTransportAuth,
  ): Promise<ExtensionCapabilityResponse> {
    const stale = staleReason(auth, request);
    if (stale) return fail(stale, "Extension request is not valid for this host generation.");
    // 身份以认证结果为准；即使 body 声称另一个已授权插件，也只会查到自己。
    const plugin = ports.plugin(auth.pluginId);
    if (!plugin) return fail("not-declared", "Plugin is not active in this window.");
    const def = getCapabilityDef(request.capabilityId);
    if (!def) return fail("unknown-capability", "Unknown extension capability.");
    const granted = ports.granted(plugin.pluginId);
    const admission = admitCapability({
      declaredCapabilities: plugin.capabilities,
      capabilityId: request.capabilityId,
      declaredProtocols: plugin.protocols,
      protocolName: def.protocol,
      compatible: def.protocol ? isProtocolCompatible(plugin.protocols, def.protocol) : true,
      granted,
      requiredGrant: def.grant,
    });
    if (!admission.ok) {
      return fail(admission.code, "Extension capability is not admitted.");
    }
    const input = def.input.safeParse(request.input ?? undefined);
    if (!input.success) return fail("invalid-input", "Extension capability input is invalid.");

    const controller = new AbortController();
    const set = inflight.get(plugin.pluginId) ?? new Set<AbortController>();
    if (set.size >= 8) return fail("too-many-requests", "Too many in-flight extension calls.");
    set.add(controller);
    inflight.set(plugin.pluginId, set);
    try {
      const result = await ports.dispatch({
        pluginId: plugin.pluginId,
        generation: request.generation,
        capabilityId: request.capabilityId,
        input: input.data,
        signal: controller.signal,
      });
      // 返回时复检：撤销、换代或工作区变化后迟到的结果不能写回调用方。
      // signal 已 abort 就一律不发布（cancelAll/cancelPlugin 的取消语义不依赖后端配合）。
      if (controller.signal.aborted)
        return fail("canceled", "Extension request was canceled while running.");
      const after = staleReason(auth, request);
      if (after) return fail(after, "Extension request became stale while running.");
      if (!grantsCover(ports.granted(plugin.pluginId), def.grant)) {
        return fail("not-granted", "Extension grant was revoked while running.");
      }
      const output = def.output.safeParse(result);
      if (!output.success) return fail("backend-error", "Extension backend result is invalid.");
      return { ok: true, result: output.data };
    } catch (error) {
      if (controller.signal.aborted) {
        return fail("canceled", "Extension request was canceled.");
      }
      // 后端只交出已分类的原因；原始错误文本不交给插件。
      if (error instanceof CapabilityDispatchError) {
        return fail(error.code, error.message);
      }
      return fail("backend-error", "Extension backend failed.");
    } finally {
      set.delete(controller);
      if (set.size === 0) inflight.delete(plugin.pluginId);
    }
  }

  async function contribute(
    request: ExtensionContributionRequest,
    auth: ExtensionTransportAuth,
  ): Promise<ExtensionContributionResponse> {
    const stale = staleReason(auth, request);
    if (stale) return fail(stale, "Extension contribution is not valid for this host generation.");
    if (!ports.consented(auth.pluginId)) {
      return fail("not-granted", "Extension consent was revoked.");
    }
    const plugin = ports.plugin(auth.pluginId);
    if (!plugin) return fail("not-declared", "Plugin is not active in this window.");
    const permitted = new Set(plugin.slotIds);
    if (!request.slots.every((slot) => permitted.has(slot.id))) {
      return fail("invalid-contribution", "Contribution is not declared by the plugin.");
    }
    const revision = ports.onContribution(
      plugin.pluginId,
      sortSlotProjections(
        request.slots.map((slot) => ({
          ...slot,
          pluginId: plugin.pluginId,
          pluginName: plugin.name,
          generation: request.generation,
        })),
      ),
    );
    return { ok: true, revision };
  }

  return { call, contribute, cancelPlugin, cancelAll };
}

function fail(
  code: ExtensionErrorCode,
  message: string,
): { ok: false; code: ExtensionErrorCode; message: string } {
  return { ok: false, code, message };
}
