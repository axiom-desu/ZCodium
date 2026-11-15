import {
  grantsCover,
  normalizeGrants,
  type ExtensionGrant,
  type ExtensionGrantRecord,
  type ExtensionGrantState,
  type ExtensionProtocolName,
  type ExtensionProtocols,
} from "@zcode/shared/extension-host";

/**
 * 授权状态的纯计算：唯一输入是「当前清单声明」与「已记录的用户授予」。
 * 不做 IO；文件读写与写入原子性由 adapters/grantStore 负责。
 */
export interface DeclaredPlugin {
  pluginId: string;
  name: string;
  version: string;
  /** 清单声明且宿主能力表里存在的能力。 */
  capabilities: string[];
  /** 清单声明的槽位 id。 */
  slotIds: string[];
  protocols: ExtensionProtocols;
  declared: ExtensionGrant[];
}

/**
 * 计算一个插件的授权状态。
 *
 * - 没有记录 / 声明未授予 / 插件升级导致声明变化（consentVersion 不同）→ needs-consent。
 *   needs-consent 的插件不会被激活：没有用户同意记录就不加载 main、不启动进程。
 * - 记录覆盖当前声明且 consentVersion 一致 → granted。
 * - 插件不在当前静态表里 → inactive（记录保留，供撤销）。
 */
export function resolveGrantState(
  declared: DeclaredPlugin,
  record: ExtensionGrantRecord | undefined,
): ExtensionGrantState {
  const normalizedDeclared = normalizeGrants(declared.declared);
  if (!record) {
    return {
      pluginId: declared.pluginId,
      name: declared.name,
      declared: normalizedDeclared,
      granted: [],
      recorded: [],
      status: "needs-consent",
    };
  }
  const consentCurrent = record.consentVersion === declared.version;
  const covers = normalizedDeclared.every((grant) =>
    grantsCover(record.grants, grant as ExtensionGrant),
  );
  const granted = consentCurrent && covers ? normalizedDeclared : [];
  return {
    pluginId: declared.pluginId,
    name: declared.name,
    declared: normalizedDeclared,
    granted,
    recorded: normalizeGrants(record.grants),
    status: granted.length === normalizedDeclared.length ? "granted" : "needs-consent",
    consentedAt: record.consentedAt,
  };
}

/** 未在静态表里的插件：声明为空，记录原样展示。 */
export function resolveInactiveGrantState(
  pluginId: string,
  record: ExtensionGrantRecord | undefined,
): ExtensionGrantState {
  return {
    pluginId,
    name: record?.name ?? pluginId,
    declared: [],
    granted: [],
    recorded: record ? normalizeGrants(record.grants) : [],
    status: "inactive",
    ...(record ? { consentedAt: record.consentedAt } : {}),
  };
}

type GrantDecision =
  | { ok: true; record: ExtensionGrantRecord }
  | { ok: false; code: "stale-approval"; message: string };

/**
 * 校验一次授权请求：用户看到的档位必须与当前清单声明完全一致。
 * 只授予请求里明确列出且被声明覆盖的档位；不接受多余档位或过期对话框的值。
 * 声明为空时也允许请求为空：这表示用户明确同意运行一个不需要能力档位的插件，
 * 该空记录同样是激活同意，不能被当作「未授权代码可直接运行」。
 */
export function decideGrant(input: {
  declared: DeclaredPlugin;
  requested: readonly ExtensionGrant[];
  now: number;
}): GrantDecision {
  const declared = normalizeGrants(input.declared.declared);
  const requested = normalizeGrants(input.requested);
  const same =
    declared.length === requested.length &&
    declared.every((grant, index) => requested[index] === grant);
  if (!same) {
    return {
      ok: false,
      code: "stale-approval",
      message: "Grant request no longer matches the declared grants.",
    };
  }
  return {
    ok: true,
    record: {
      pluginId: input.declared.pluginId,
      name: input.declared.name,
      grants: requested,
      consentVersion: input.declared.version,
      consentedAt: input.now,
    },
  };
}

/** 用户是否已同意运行该插件（声明可为空；必须有匹配当前版本的记录）。 */
export function isGrantRunnable(state: ExtensionGrantState): boolean {
  return state.status === "granted";
}

/**
 * 能力调用准入的纯判定：声明 → 协议 → 授权。
 * 返回第一个失败原因，便于扩展与 UI 区分「没声明」「没授权」「协议不兼容」。
 */
type CapabilityAdmission =
  | { ok: true }
  | { ok: false; code: "not-declared" | "not-granted" | "incompatible" };

export function admitCapability(input: {
  declaredCapabilities: readonly string[];
  capabilityId: string;
  declaredProtocols: ExtensionProtocols;
  protocolName?: ExtensionProtocolName;
  compatible: boolean;
  granted: readonly ExtensionGrant[];
  requiredGrant: "none" | ExtensionGrant;
}): CapabilityAdmission {
  if (!input.declaredCapabilities.includes(input.capabilityId)) {
    return { ok: false, code: "not-declared" };
  }
  if (input.protocolName && !input.compatible) return { ok: false, code: "incompatible" };
  if (!grantsCover(input.granted, input.requiredGrant)) return { ok: false, code: "not-granted" };
  return { ok: true };
}
