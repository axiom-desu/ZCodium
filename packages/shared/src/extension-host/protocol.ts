import { z } from "zod";
import { extensionSlotContributionSchema } from "./contributions.js";

/**
 * 宿主内部线协议：扩展进程 ↔ 窗口 Local Host（loopback HTTP）、扩展进程 ↔ Main（stdio）。
 * 两种帧都携带 workspaceIdentity 与 generation；任何不匹配都按 stale-generation /
 * workspace-mismatch 拒绝，旧代际的迟到结果不能写回新代际。
 */
export const EXTENSION_PROTOCOL_VERSION = 1;
export const EXTENSION_LOOPBACK_MAX_BODY_BYTES = 256 * 1024;
export const EXTENSION_STARTUP_TIMEOUT_MS = 10_000;
export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 3_000;
export const EXTENSION_MAX_INFLIGHT_PER_PLUGIN = 8;
export const EXTENSION_VIEW_SERVER_HOST = "127.0.0.1";

/**
 * 扩展进程从 Main 收到的环境变量名（显式 allowlist，不继承整份环境）。
 * 凭据不在环境里：token 只经 stdin 一次性 bootstrap 帧下发，读后即消耗。
 */
export const EXTENSION_HOST_ENV = {
  endpoint: "ZCODE_EXTENSION_HOST_ENDPOINT",
  /** 每个插件子进程只收到自己的 endpoint/身份/目录；不向插件传递 peer token。 */
  generation: "ZCODE_EXTENSION_HOST_GENERATION",
  workspaceIdentity: "ZCODE_EXTENSION_HOST_WORKSPACE_IDENTITY",
  /** 只指向当前插件自己的目录，worker 不得扫描其他插件。 */
  pluginDir: "ZCODE_EXTENSION_HOST_PLUGIN_DIR",
  pluginId: "ZCODE_EXTENSION_HOST_PLUGIN_ID",
} as const;

export const extensionErrorCodeSchema = z.enum([
  "unauthorized",
  "stale-generation",
  "workspace-mismatch",
  "unknown-capability",
  "not-declared",
  "not-granted",
  "incompatible",
  "invalid-input",
  "canceled",
  // 会话 facade（E8）：按 session-control 同名错误映射，扩展按 code 判断而不是读文本。
  "forbidden",
  "unavailable",
  "conflict",
  "backend-error",
  "invalid-contribution",
  "too-many-requests",
  "host-unavailable",
]);
export type ExtensionErrorCode = z.infer<typeof extensionErrorCodeSchema>;

/** 能力调用请求；身份只来自 Authorization 头，body 的 pluginId 必须与认证身份一致。 */
export const extensionCapabilityRequestSchema = z.strictObject({
  v: z.literal(EXTENSION_PROTOCOL_VERSION),
  generation: z.number().int().nonnegative(),
  workspaceIdentity: z.string().min(1).max(2048),
  pluginId: z.string().min(1).max(128),
  capabilityId: z.string().min(1).max(64),
  input: z.unknown().optional(),
  requestId: z.string().min(1).max(128).optional(),
});
export type ExtensionCapabilityRequest = z.infer<typeof extensionCapabilityRequestSchema>;

export const extensionCapabilityResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    code: extensionErrorCodeSchema,
    message: z.string().max(500),
  }),
]);
export type ExtensionCapabilityResponse = z.infer<typeof extensionCapabilityResponseSchema>;

/** 扩展推送贡献快照；整份替换，不做增量补丁，避免顺序与丢包产生分叉。 */
export const extensionContributionRequestSchema = z.strictObject({
  v: z.literal(EXTENSION_PROTOCOL_VERSION),
  generation: z.number().int().nonnegative(),
  workspaceIdentity: z.string().min(1).max(2048),
  pluginId: z.string().min(1).max(128),
  slots: z.array(extensionSlotContributionSchema).max(16),
});
export type ExtensionContributionRequest = z.infer<typeof extensionContributionRequestSchema>;

export const extensionContributionResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), revision: z.number().int().nonnegative() }),
  z.strictObject({
    ok: z.literal(false),
    code: extensionErrorCodeSchema,
    message: z.string().max(500),
  }),
]);
export type ExtensionContributionResponse = z.infer<typeof extensionContributionResponseSchema>;

/** 扩展进程 → Main（stdio，逐行 JSON）。 */
export const extensionHostProcessMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    generation: z.number().int().nonnegative(),
    pluginId: z.string().min(1).max(128),
  }),
  z.strictObject({ type: z.literal("error"), message: z.string().max(500) }),
  z.strictObject({
    type: z.literal("log"),
    level: z.enum(["info", "warn"]),
    message: z.string().max(500),
  }),
]);
export type ExtensionHostProcessMessage = z.infer<typeof extensionHostProcessMessageSchema>;

/**
 * Main → 扩展进程的第一帧：一次性 bootstrap。
 * 必须经继承的私有 stdin 管道传入，禁止放进环境变量或 argv；worker 读取后即消耗，
 * 不写入日志/ready/error/stdout。
 */
export const extensionHostBootstrapFrameSchema = z.strictObject({
  type: z.literal("bootstrap"),
  token: z.string().min(1).max(256),
});
export type ExtensionHostBootstrapFrame = z.infer<typeof extensionHostBootstrapFrameSchema>;

/** Main → 扩展进程（stdio，bootstrap 之后的后续帧）。 */
export const extensionHostMainMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("shutdown") }),
]);
export type ExtensionHostMainMessage = z.infer<typeof extensionHostMainMessageSchema>;

/**
 * Host → Main 的启动载荷；Main 只用于拉起进程，不持有授权或槽位状态。
 * `token` 只进入 Main 内存并经 stdin bootstrap 转交；不得写进子进程环境。
 */
export interface ExtensionHostStartPayload {
  requestId: string;
  ownerWebContentsId: number;
  generation: number;
  workspaceIdentity: string;
  endpoint: string;
  token: string;
  /** 每个插件独立进程：目录只指向该插件自身。 */
  pluginDir: string;
  pluginId: string;
}

export type ExtensionHostStartResultPayload =
  | { requestId: string; ok: true; pid: number }
  | { requestId: string; ok: false; error: string };

export interface ExtensionHostStopPayload {
  requestId: string;
  ownerWebContentsId: number;
  /** 只停止该窗口当前代际；不匹配时 Main 返回 inactive。 */
  generation: number;
  /** 指定时只停止该插件进程；缺省停止该代际全部插件进程。 */
  pluginId?: string;
}

export type ExtensionHostStopResultPayload =
  | { requestId: string; ok: true; stopped: boolean }
  | { requestId: string; ok: false; error: string };
