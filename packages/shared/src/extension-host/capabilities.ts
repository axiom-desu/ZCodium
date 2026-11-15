import { z } from "zod";
import type { CapabilityGrant, ExtensionProtocolName } from "./grants.js";

/**
 * 能力表：能力的唯一定义。表里没有的能力就不存在。
 *
 * 新增能力只改两处：这里加一行；`services/extensions` 的能力网关加一个后端处理函数。
 * `backend` 标明由现有服务（service）还是由 Host 投影泵（pump）提供；扩展进程与 Renderer
 * 都不直接持有业务状态。
 */
export interface CapabilityDef {
  kind: "call" | "subscribe";
  input: z.ZodType;
  output: z.ZodType;
  backend: "service" | "pump";
  grant: CapabilityGrant;
  protocol?: ExtensionProtocolName;
  /** 入参带幂等键 `requestId`；ctx 类型把它改成可选，扩展侧统一补 UUID。 */
  requestIdentity?: true;
}

const workspaceIdentitySchema = z.string().min(1).max(2048);

export const extensionProjectSummarySchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(512),
});
export type ExtensionProjectSummary = z.infer<typeof extensionProjectSummarySchema>;

export const extensionSettingsProjectionSchema = z.strictObject({
  /** 只有界面语言属于安全的设置投影；敏感设置值不进入扩展面。 */
  locale: z.string().max(64),
});
export type ExtensionSettingsProjection = z.infer<typeof extensionSettingsProjectionSchema>;

export const extensionContextSchema = z.strictObject({
  workspaceIdentity: workspaceIdentitySchema,
  /** 扩展宿主投影修订号（授权/槽位/代际变化）；扩展据此刷新自己的视图。 */
  revision: z.number().int().nonnegative(),
});
export type ExtensionContextProjection = z.infer<typeof extensionContextSchema>;

export const EXTENSION_CAPABILITIES = {
  // 只给非敏感投影；设置敏感值不进入扩展面。
  "settings.get": {
    kind: "call",
    input: z.undefined(),
    output: extensionSettingsProjectionSchema,
    backend: "service",
    grant: "none",
  },
  // 唯一 owner 是 Host 的项目服务；这里只返回 id/name 投影。
  "projects.list": {
    kind: "call",
    input: z.undefined(),
    output: z.array(extensionProjectSummarySchema),
    backend: "service",
    grant: "projects.read",
    protocol: "projects",
  },
  "context.get": {
    kind: "call",
    input: z.undefined(),
    output: extensionContextSchema,
    backend: "pump",
    grant: "none",
  },
} as const satisfies Record<string, CapabilityDef>;

export type ExtensionCapabilityTable = typeof EXTENSION_CAPABILITIES;
export type CapabilityId = keyof ExtensionCapabilityTable & string;
export type CapabilityInput<K extends CapabilityId> = z.input<ExtensionCapabilityTable[K]["input"]>;
export type CapabilityOutput<K extends CapabilityId> = z.output<
  ExtensionCapabilityTable[K]["output"]
>;

export function isCapabilityId(id: string): id is CapabilityId {
  return Object.hasOwn(EXTENSION_CAPABILITIES, id);
}

export function getCapabilityDef(id: string): CapabilityDef | undefined {
  return isCapabilityId(id)
    ? (EXTENSION_CAPABILITIES as Record<string, CapabilityDef>)[id]
    : undefined;
}

export function listCapabilities(): Array<[string, CapabilityDef]> {
  return Object.entries(EXTENSION_CAPABILITIES as Record<string, CapabilityDef>);
}
