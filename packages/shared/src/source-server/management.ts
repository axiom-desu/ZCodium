import { z } from "zod";
import { publicZCodeErrorCodeSchema } from "./errorCodes.js";
import { sourceServerNonEmptyStringSchema, sourceServerTimestampSchema } from "./primitives.js";
import { connectionProfileSchema } from "./profiles.js";
import { sourceServerRecordSchema, sourceServerWorkspaceHistoryEntrySchema } from "./workspace.js";

export const sourceServerConnectionStateSchema = z.enum([
  "absent",
  "bootstrapping",
  "needs-install",
  "needs-upgrade",
  "updating",
  "online",
  "retrying",
  "offline",
  "identity-change-pending",
  "failed",
]);
export type SourceServerConnectionState = z.infer<typeof sourceServerConnectionStateSchema>;

/** 远端任务 owner 的活动投影；身份用于隔离，实际路径仅用于展示。 */
export const sourceServerRunningTaskSchema = z
  .object({
    sessionId: sourceServerNonEmptyStringSchema,
    workspacePath: sourceServerNonEmptyStringSchema,
    workspaceIdentity: sourceServerNonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerRunningTask = z.infer<typeof sourceServerRunningTaskSchema>;
export const sourceServerRunningTasksSchema = z.array(sourceServerRunningTaskSchema);

/** 只读安装预览；sizeBytes 是安装包实际大小，不代表解压后的磁盘占用。 */
export const sourceServerInstallPreviewSchema = z
  .object({
    version: sourceServerNonEmptyStringSchema,
    installPath: sourceServerNonEmptyStringSchema.optional(),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type SourceServerInstallPreview = z.infer<typeof sourceServerInstallPreviewSchema>;

export const sourceServerConnectionStateSnapshotSchema = z
  .object({
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    state: sourceServerConnectionStateSchema,
    error: z.string().optional(),
    updateAvailability: z.enum(["none", "available", "required"]).optional(),
    currentVersion: sourceServerNonEmptyStringSchema.optional(),
    availableVersion: sourceServerNonEmptyStringSchema.optional(),
    minimumVersion: sourceServerNonEmptyStringSchema.optional(),
    upgradeTarget: z.enum(["controller", "server"]).optional(),
    errorCode: publicZCodeErrorCodeSchema.optional(),
    retryable: z.boolean().optional(),
    installPreview: sourceServerInstallPreviewSchema.optional(),
    runningTasks: sourceServerRunningTasksSchema.optional(),
    pendingSourceServerId: z.string().uuid().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    updatedAt: sourceServerTimestampSchema,
  })
  .strict();
export type SourceServerConnectionStateSnapshot = z.infer<
  typeof sourceServerConnectionStateSnapshotSchema
>;

export const sourceServerManagementSnapshotRequestSchema = z
  .object({
    refreshMigrationCounts: z.boolean().optional(),
  })
  .strict();
export type SourceServerManagementSnapshotRequest = z.infer<
  typeof sourceServerManagementSnapshotRequestSchema
>;

export const sourceServerManagementSnapshotSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    profiles: z.array(connectionProfileSchema),
    servers: z.array(sourceServerRecordSchema),
    workspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema),
    states: z.array(sourceServerConnectionStateSnapshotSchema),
    failedPathCount: z.number().int().nonnegative(),
    abandonedPathCount: z.number().int().nonnegative(),
    migrationCounts: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            sourceServerId: sourceServerNonEmptyStringSchema,
            status: z.literal("available"),
            failedPathCount: z.number().int().nonnegative(),
            abandonedPathCount: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            sourceServerId: sourceServerNonEmptyStringSchema,
            status: z.literal("requires-connection"),
          })
          .strict(),
        z
          .object({
            sourceServerId: sourceServerNonEmptyStringSchema,
            status: z.literal("loading"),
          })
          .strict(),
        z
          .object({
            sourceServerId: sourceServerNonEmptyStringSchema,
            status: z.literal("unavailable"),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type SourceServerManagementSnapshot = z.infer<typeof sourceServerManagementSnapshotSchema>;

export const sourceServerManagementStateDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
    state: sourceServerConnectionStateSnapshotSchema,
  })
  .strict();
export type SourceServerManagementStateDelta = z.infer<
  typeof sourceServerManagementStateDeltaSchema
>;

export const sourceServerManagementDirectoryDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
  })
  .strict();
export type SourceServerManagementDirectoryDelta = z.infer<
  typeof sourceServerManagementDirectoryDeltaSchema
>;

/** Server CLI 的可选逐行进度；终态仍由退出码和最后一行结果决定。 */
export const sourceServerInstallProgressSchema = z
  .object({
    type: z.literal("source-server-install-progress"),
    phase: z.enum(["verify-archive", "extract", "verify", "restart"]),
  })
  .strict();
export type SourceServerInstallProgress = z.infer<typeof sourceServerInstallProgressSchema>;

export const sourceServerOperationLogSchema = z
  .object({
    profileId: z.string().uuid(),
    operation: z.enum(["connect", "update"]),
    phase: sourceServerNonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    progress: z.number().min(0).max(1).optional(),
    timestamp: sourceServerTimestampSchema,
  })
  .strict();
export type SourceServerOperationLog = z.infer<typeof sourceServerOperationLogSchema>;
