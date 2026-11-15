import { z } from "zod";

/**
 * 扩展权限档位（extension-host 模块）。
 *
 * 档位由插件清单声明、用户显式授予；能力表每一行写明自己需要的档位（none 表示不需要授权）。
 * 授权状态由 `services/extensions` 的授权存储唯一持有，扩展进程、Main 与 Renderer 都只读投影。
 * 默认拒绝：没有记录、记录与当前声明不一致、或进程代际/工作区不匹配都按未授权处理。
 */
export const EXTENSION_GRANTS = ["projects.read", "sessions.read", "sessions.write"] as const;
export const extensionGrantSchema = z.enum(EXTENSION_GRANTS);
export type ExtensionGrant = z.infer<typeof extensionGrantSchema>;

/** 会话档位链，低到高：高档包含低档（write ⊇ read）。 */
const SESSION_GRANT_CHAIN: readonly ExtensionGrant[] = ["sessions.read", "sessions.write"];

/** 能力表一行需要的档位。 */
export type CapabilityGrant = "none" | ExtensionGrant;

/** held 是否覆盖 needed：相同，或会话链上 held 不低于 needed。 */
export function grantCovers(held: ExtensionGrant, needed: ExtensionGrant): boolean {
  if (held === needed) return true;
  const heldRank = SESSION_GRANT_CHAIN.indexOf(held);
  const neededRank = SESSION_GRANT_CHAIN.indexOf(needed);
  return heldRank >= 0 && neededRank >= 0 && heldRank > neededRank;
}

/** 一组档位是否覆盖 needed；none 恒为覆盖。 */
export function grantsCover(held: readonly ExtensionGrant[], needed: CapabilityGrant): boolean {
  return needed === "none" || held.some((grant) => grantCovers(grant, needed));
}

/** 去重并丢掉被会话链上更高档位覆盖的项，按 EXTENSION_GRANTS 顺序返回。 */
export function normalizeGrants(grants: readonly ExtensionGrant[]): ExtensionGrant[] {
  const unique = [...new Set(grants)];
  return EXTENSION_GRANTS.filter(
    (grant) =>
      unique.includes(grant) &&
      !unique.some((other) => other !== grant && grantCovers(other, grant)),
  );
}

/** 插件可依赖的稳定投影版本。只加字段不升版；删字段或改含义才升版。 */
export const EXTENSION_PROTOCOL_VERSIONS = { projects: 1, sessions: 1 } as const;
export type ExtensionProtocolName = keyof typeof EXTENSION_PROTOCOL_VERSIONS;

export const extensionProtocolsSchema = z.strictObject({
  projects: z.number().int().positive().optional(),
  sessions: z.number().int().positive().optional(),
});
export type ExtensionProtocols = z.infer<typeof extensionProtocolsSchema>;

/** 清单声明的协议版本是否与宿主一致；没有声明视为一致。 */
export function isProtocolCompatible(
  declared: ExtensionProtocols,
  name: ExtensionProtocolName,
): boolean {
  const version = declared[name];
  return version === undefined || version === EXTENSION_PROTOCOL_VERSIONS[name];
}

/**
 * 一个插件的授权状态（唯一 owner：`services/extensions` 的授权存储）。
 * - granted：当前声明已被用户授予，能力调用可用 `granted` 里的档位。
 * - needs-consent：声明了档位但尚未授予，或插件更新后声明变多（含 read→write）。
 * - inactive：有记录但插件已不在静态表里；禁用不删除记录，便于撤销。
 */
export const extensionGrantStatusSchema = z.enum(["granted", "needs-consent", "inactive"]);
export type ExtensionGrantStatus = z.infer<typeof extensionGrantStatusSchema>;

export const extensionGrantStateSchema = z.strictObject({
  pluginId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  /** 清单当前声明的档位（去重）。inactive 时为空。 */
  declared: z.array(extensionGrantSchema),
  /** 当前生效档位；needs-consent 与 inactive 时为空。 */
  granted: z.array(extensionGrantSchema),
  /** 记录里已授予的档位；inactive 时给撤销界面显示用。 */
  recorded: z.array(extensionGrantSchema),
  status: extensionGrantStatusSchema,
  consentedAt: z.number().int().nonnegative().optional(),
});
export type ExtensionGrantState = z.infer<typeof extensionGrantStateSchema>;

/** 授权存储文件的一行；`consentVersion` 跟随平台清单版本，插件升级后声明变化会回到待授权。 */
export const extensionGrantRecordSchema = z.strictObject({
  pluginId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  grants: z.array(extensionGrantSchema),
  consentVersion: z.string().min(1).max(64),
  consentedAt: z.number().int().nonnegative(),
});
export type ExtensionGrantRecord = z.infer<typeof extensionGrantRecordSchema>;

/** 授权文件格式；只保存用户明确授予过的内容。 */
export const extensionGrantsFileSchema = z.strictObject({
  v: z.literal(1),
  records: z.array(extensionGrantRecordSchema).max(512),
});
export type ExtensionGrantsFile = z.infer<typeof extensionGrantsFileSchema>;
