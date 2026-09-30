import { z } from "zod";
import {
  webRemoteControlRpcFrameAckEnvelopeSchema,
  webRemoteControlRpcFrameEnvelopeSchema,
} from "./rpcTransport.js";

/**
 * 手机远控（Web Remote Control）应用层信封契约。
 *
 * 单一事实源：桌面 main、移动端 web 与（可选的）用户自托管 relay 都按这里的 zod 收发，
 * 不在任何一侧复制字段定义。字段与官方 3.14.3 恢复结果对齐；官方未公开的常量在
 * `.agents/specs/web-remote-control.md` 标注「待验证」，这里给可配置默认值。
 */

const nonEmptyStringSchema = z.string().trim().min(1);
const requestIdSchema = nonEmptyStringSchema;
const bridgeSessionIdSchema = nonEmptyStringSchema;

export const webRemoteControlWorkspaceKindSchema = z.enum(["local", "remote", "conversation"]);
export type WebRemoteControlWorkspaceKind = z.infer<typeof webRemoteControlWorkspaceKindSchema>;

export const webRemoteControlTaskStatusSchema = z.enum(["idle", "running", "completed", "error"]);
export type WebRemoteControlTaskStatus = z.infer<typeof webRemoteControlTaskStatusSchema>;

export const webRemoteControlWorkspaceRefSchema = z
  .object({
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    kind: webRemoteControlWorkspaceKindSchema,
    connectionState: z.enum(["connected", "connecting", "disconnected"]).optional(),
    lastConnectionError: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
export type WebRemoteControlWorkspaceRef = z.infer<typeof webRemoteControlWorkspaceRefSchema>;

export const webRemoteControlTaskRefSchema = z
  .object({
    workspaceKey: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    title: z.string(),
    remoteSessionId: z.string().optional(),
    displayStatus: webRemoteControlTaskStatusSchema.optional(),
    hasBackgroundWork: z.boolean().optional(),
    workflowActivity: z.string().nullable().optional(),
    unreadAt: z.number().int().nonnegative().nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WebRemoteControlTaskRef = z.infer<typeof webRemoteControlTaskRefSchema>;

export const webRemoteControlMobileViewStateSchema = z
  .object({
    activeWorkspaceKey: nonEmptyStringSchema,
    activeTaskId: z.string().optional(),
  })
  .strict();
export type WebRemoteControlMobileViewState = z.infer<typeof webRemoteControlMobileViewStateSchema>;

export const webRemoteControlMobileDeviceInfoSchema = z
  .object({
    userAgent: z.string().optional(),
    viewport: z
      .object({
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WebRemoteControlMobileDeviceInfo = z.infer<
  typeof webRemoteControlMobileDeviceInfoSchema
>;

/** 移动端可调用的平台方法；桌面侧 platformHandlers 只实现这个集合。 */
export const webRemoteControlPlatformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "createTempTextAttachment",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);
export type WebRemoteControlPlatformMethod = z.infer<typeof webRemoteControlPlatformMethodSchema>;

/** bridge 就绪后桌面回给移动端的桥接描述。 */
export const webRemoteControlBridgeDescriptorSchema = z
  .object({
    bridgeSessionId: bridgeSessionIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: nonEmptyStringSchema.optional(),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    kind: webRemoteControlWorkspaceKindSchema,
    entryKind: z.enum(["home", "task"]),
  })
  .strict();
export type WebRemoteControlBridgeDescriptor = z.infer<
  typeof webRemoteControlBridgeDescriptorSchema
>;

export const webRemoteControlBootstrapResultSchema = z
  .object({
    windowControlSessionId: nonEmptyStringSchema,
    desktopAppVersion: nonEmptyStringSchema,
    workspaces: z.array(webRemoteControlWorkspaceRefSchema),
    tasks: z.array(webRemoteControlTaskRefSchema),
    initialViewState: webRemoteControlMobileViewStateSchema.optional(),
    mobileViewState: webRemoteControlMobileViewStateSchema.optional(),
  })
  .strict();

export const webRemoteControlWorkspaceListResultSchema = z
  .object({
    workspaces: z.array(webRemoteControlWorkspaceRefSchema),
    tasks: z.array(webRemoteControlTaskRefSchema),
    activeWorkspaceKey: nonEmptyStringSchema,
    activeTaskId: z.string().optional(),
  })
  .strict();

const bootstrapRequestSchema = z
  .object({
    zcode_type: z.literal("bootstrap-request"),
    requestId: requestIdSchema,
  })
  .strict();

const bootstrapResponseSchema = z
  .object({
    zcode_type: z.literal("bootstrap-response"),
    requestId: requestIdSchema,
    success: z.literal(true),
    result: webRemoteControlBootstrapResultSchema,
  })
  .strict();

const workspaceListRequestSchema = z
  .object({
    zcode_type: z.literal("workspace-list-request"),
    requestId: requestIdSchema,
  })
  .strict();

const workspaceListResponseSchema = z
  .object({
    zcode_type: z.literal("workspace-list-response"),
    requestId: requestIdSchema,
    success: z.literal(true),
    result: webRemoteControlWorkspaceListResultSchema,
  })
  .strict();

const workspaceListUpdatedSchema = z
  .object({
    zcode_type: z.literal("workspace-list-updated"),
    result: webRemoteControlWorkspaceListResultSchema,
  })
  .strict();

const platformRequestSchema = z
  .object({
    zcode_type: z.literal("platform-request"),
    requestId: requestIdSchema,
    method: webRemoteControlPlatformMethodSchema,
    args: z.unknown(),
  })
  .strict();

const platformResponseSchema = z
  .object({
    zcode_type: z.literal("platform-response"),
    requestId: requestIdSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();

const mobileViewStateUpdateSchema = z
  .object({
    zcode_type: z.literal("mobile-view-state-update"),
    viewState: webRemoteControlMobileViewStateSchema,
    deviceInfo: webRemoteControlMobileDeviceInfoSchema.optional(),
  })
  .strict();

const workspaceBridgeOpenSchema = z
  .object({
    zcode_type: z.literal("workspace-bridge-open"),
    requestId: requestIdSchema,
    workspaceKey: nonEmptyStringSchema,
    taskId: z.string().optional(),
    bridgeSessionId: bridgeSessionIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: nonEmptyStringSchema.optional(),
  })
  .strict();

const workspaceBridgeReadySchema = z
  .object({
    zcode_type: z.literal("workspace-bridge-ready"),
    requestId: requestIdSchema,
    bridgeSessionId: bridgeSessionIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: nonEmptyStringSchema.optional(),
    bridge: webRemoteControlBridgeDescriptorSchema,
  })
  .strict();

const workspaceBridgeErrorSchema = z
  .object({
    zcode_type: z.literal("workspace-bridge-error"),
    requestId: requestIdSchema,
    bridgeSessionId: bridgeSessionIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: nonEmptyStringSchema.optional(),
    reason: z.string(),
    error: z.string().optional(),
  })
  .strict();

const workspaceReconnectRequestSchema = z
  .object({
    zcode_type: z.literal("workspace-reconnect-request"),
    requestId: requestIdSchema,
    workspaceKey: nonEmptyStringSchema,
  })
  .strict();

const workspaceReconnectResponseSchema = z
  .object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: requestIdSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

const appErrorSchema = z
  .object({
    zcode_type: z.literal("app-error"),
    reason: z.string(),
    error: z.string().optional(),
  })
  .strict();

const bridgeDegradedSchema = z
  .object({
    zcode_type: z.literal("bridge-degraded"),
    bridgeSessionId: bridgeSessionIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: nonEmptyStringSchema.optional(),
    reason: z.string(),
  })
  .strict();

const telemetryReportSchema = z
  .object({
    zcode_type: z.literal("telemetry-report"),
    event: z.unknown(),
  })
  .strict();

const mobileDiagnosticSchema = z
  .object({
    zcode_type: z.literal("mobile-diagnostic"),
    event: z.string(),
    state: z.string().optional(),
    previousState: z.string().optional(),
    pairStatus: z.string().optional(),
    closeCode: z.number().int().optional(),
    closeReason: z.string().optional(),
    wasClean: z.boolean().optional(),
    wasPaired: z.boolean().optional(),
    failureReason: z.string().optional(),
    failureMessage: z.string().optional(),
    visibilityState: z.string().optional(),
    online: z.boolean().optional(),
    hiddenDurationMs: z.number().int().nonnegative().optional(),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();

export const webRemoteControlAppPayloadSchema = z.discriminatedUnion("zcode_type", [
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  workspaceListRequestSchema,
  workspaceListResponseSchema,
  workspaceListUpdatedSchema,
  platformRequestSchema,
  platformResponseSchema,
  mobileViewStateUpdateSchema,
  workspaceBridgeOpenSchema,
  workspaceBridgeReadySchema,
  workspaceBridgeErrorSchema,
  workspaceReconnectRequestSchema,
  workspaceReconnectResponseSchema,
  appErrorSchema,
  bridgeDegradedSchema,
  telemetryReportSchema,
  mobileDiagnosticSchema,
  webRemoteControlRpcFrameEnvelopeSchema,
  webRemoteControlRpcFrameAckEnvelopeSchema,
]);
export type WebRemoteControlAppPayload = z.infer<typeof webRemoteControlAppPayloadSchema>;

export type WebRemoteControlBootstrapResult = z.infer<typeof webRemoteControlBootstrapResultSchema>;
export type WebRemoteControlWorkspaceListResult = z.infer<
  typeof webRemoteControlWorkspaceListResultSchema
>;
