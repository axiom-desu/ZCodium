import {
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appInterruptSessionInputSchema,
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appListSessionsResultSchema,
  appOpenSessionInputSchema,
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appSendToSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  appWaitSessionsInputSchema,
  createSessionResultSchema,
  forkSessionResultSchema,
  listProjectsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  waitSessionsResultSchema,
} from "@zcode/session-control/contracts";
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
  // 会话 facade 的四个读：入参与返回直接复用 session-control 的 App 端口 schema，
  // 与模型的会话控制工具同一份定义；调用方是客户端类（AppControlService.bindClient）。
  // waitSessions 跨 RPC 不可取消，只在换代/停止/撤销授权时中止。
  "sessions.listProjects": {
    kind: "call",
    input: appListProjectsInputSchema,
    output: listProjectsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  "sessions.listSessions": {
    kind: "call",
    input: appListSessionsInputSchema,
    output: appListSessionsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  "sessions.readSession": {
    kind: "call",
    input: appReadSessionInputSchema,
    output: readSessionResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  "sessions.waitSessions": {
    kind: "call",
    input: appWaitSessionsInputSchema,
    output: waitSessionsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // 会话 facade 的八个写：写档位包含读；每次调用都由网关注入插件身份，
  // 不新建 session/task owner，也不允许插件自报身份。
  "sessions.createSession": {
    kind: "call",
    input: appCreateSessionInputSchema,
    output: createSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.forkSession": {
    kind: "call",
    input: appForkSessionInputSchema,
    output: forkSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.sendToSession": {
    kind: "call",
    input: appSendToSessionInputSchema,
    output: sendToSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.interruptSession": {
    kind: "call",
    input: appInterruptSessionInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.renameSession": {
    kind: "call",
    input: appRenameSessionInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  // 在发起方绑定的窗口里打开会话；uiTarget 只由可信上下文决定，没有 requestId。
  "sessions.openSession": {
    kind: "call",
    input: appOpenSessionInputSchema,
    output: openSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
  },
  "sessions.setSessionArchived": {
    kind: "call",
    input: appSetSessionArchivedInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.setSessionPinned": {
    kind: "call",
    input: appSetSessionPinnedInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
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
