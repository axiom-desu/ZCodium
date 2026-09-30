import { z } from "zod";

/**
 * 桌面远控运行时状态与 IPC 契约。
 * 状态机见 `.agents/specs/web-remote-control.md`；failure 文案键与 i18n 的
 * `webRemoteControl.failure.*` 一一对应（reason 即键名驼峰段）。
 */

const nonEmptyStringSchema = z.string().trim().min(1);

export const webRemoteControlStatusStateSchema = z.enum([
  "idle",
  "starting",
  "connecting",
  "running",
  "active",
  "error",
  "cancelled",
]);
export type WebRemoteControlStatusState = z.infer<typeof webRemoteControlStatusStateSchema>;

export const webRemoteControlFailureReasonSchema = z.enum([
  "sessionNotFound",
  "sessionExpired",
  "sessionConflict",
  "kicked",
  "workspaceClosed",
  "desktopDisconnected",
  "invalidMobileConnection",
  "desktopBootstrapTimeout",
  "connectionRecoveryTimeout",
  "relayUnavailable",
  "unsupportedAction",
  "unexpectedError",
]);
export type WebRemoteControlFailureReason = z.infer<typeof webRemoteControlFailureReasonSchema>;

export const webRemoteControlFailureSchema = z
  .object({
    reason: webRemoteControlFailureReasonSchema,
    message: z.string().optional(),
  })
  .strict();
export type WebRemoteControlFailure = z.infer<typeof webRemoteControlFailureSchema>;

export const webRemoteControlStatusSnapshotSchema = z
  .object({
    status: webRemoteControlStatusStateSchema,
    sessionId: z.string().optional(),
    windowControlSessionId: z.string().optional(),
    mobileConnected: z.boolean().optional(),
    qrUrl: z.string().optional(),
    connectUrl: z.string().optional(),
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    initialTaskId: z.string().optional(),
    error: z.string().optional(),
    failure: webRemoteControlFailureSchema.optional(),
  })
  .strict();
export type WebRemoteControlStatusSnapshot = z.infer<typeof webRemoteControlStatusSnapshotSchema>;

export const webRemoteControlStartRequestSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    initialTaskId: z.string().optional(),
  })
  .strict();
export type WebRemoteControlStartRequest = z.infer<typeof webRemoteControlStartRequestSchema>;

export const webRemoteControlResetPairingRequestSchema = webRemoteControlStartRequestSchema;
export type WebRemoteControlResetPairingRequest = WebRemoteControlStartRequest;

/** 桌面 → 移动端的 workspace/task 清单同步（窗口内已打开的工作区与任务）。 */
export const webRemoteControlWorkspaceSyncSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    workspaces: z.array(
      z
        .object({
          workspaceKey: nonEmptyStringSchema,
          workspacePath: nonEmptyStringSchema,
          workspaceIdentity: z.string().optional(),
          remoteSessionId: z.string().optional(),
          kind: z.enum(["local", "remote", "conversation"]),
          connectionState: z.enum(["connected", "connecting", "disconnected"]).optional(),
          lastConnectionError: z.string().optional(),
          label: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type WebRemoteControlWorkspaceSync = z.infer<typeof webRemoteControlWorkspaceSyncSchema>;

export const webRemoteControlTaskSyncSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    tasks: z.array(
      z
        .object({
          workspaceKey: nonEmptyStringSchema,
          taskId: nonEmptyStringSchema,
          title: z.string(),
          remoteSessionId: z.string().optional(),
          displayStatus: z.enum(["idle", "running", "completed", "error"]).optional(),
          hasBackgroundWork: z.boolean().optional(),
          workflowActivity: z.string().nullable().optional(),
          unreadAt: z.number().int().nonnegative().nullable().optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
          createdAt: z.number().int().nonnegative().optional(),
          updatedAt: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type WebRemoteControlTaskSync = z.infer<typeof webRemoteControlTaskSyncSchema>;

/** 桌面端远控端点配置：默认仅 LAN，跨网由用户显式填写自己的隧道 / relay 地址。 */
export const webRemoteControlEndpointModeSchema = z.enum(["lan", "custom"]);
export type WebRemoteControlEndpointMode = z.infer<typeof webRemoteControlEndpointModeSchema>;
