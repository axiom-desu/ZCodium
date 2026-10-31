import { z } from "zod";
import { sourceServerNonEmptyStringSchema, sourceServerTimestampSchema } from "./primitives.js";
import { serverRemoteWorkspaceInfoSchema } from "../server-remote.js";

export const sourceServerRecordSchema = z
  .object({
    sourceServerId: z.string().uuid(),
    displayName: sourceServerNonEmptyStringSchema,
    osUser: sourceServerNonEmptyStringSchema.optional(),
    hostname: sourceServerNonEmptyStringSchema.optional(),
    lastSeenVersion: sourceServerNonEmptyStringSchema.optional(),
    lastOnlineAt: sourceServerTimestampSchema.optional(),
    preferredProfileId: z.string().uuid().optional(),
    installState: z.enum(["installed", "uninstalled"]).default("installed"),
    declaredWorkspaces: z
      .array(
        z
          .object({
            workspacePath: sourceServerNonEmptyStringSchema,
            workspaceIdentity: sourceServerNonEmptyStringSchema,
            label: sourceServerNonEmptyStringSchema.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type SourceServerRecord = z.infer<typeof sourceServerRecordSchema>;

export const sourceServerWorkspaceHistoryEntrySchema = z
  .object({
    workspacePath: sourceServerNonEmptyStringSchema,
    workspaceIdentity: sourceServerNonEmptyStringSchema.optional(),
    legacyWorkspaceIdentity: sourceServerNonEmptyStringSchema.optional(),
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    lastOpenedAt: sourceServerTimestampSchema,
  })
  .strict();

export type SourceServerWorkspaceHistoryEntry = z.infer<
  typeof sourceServerWorkspaceHistoryEntrySchema
>;

export const sourceServerMigrationConflictSchema = z
  .object({
    kind: z.enum(["task-identity", "config-file"]),
    key: sourceServerNonEmptyStringSchema,
    taskId: sourceServerNonEmptyStringSchema.optional(),
    relativePath: sourceServerNonEmptyStringSchema.optional(),
    sourceKey: sourceServerNonEmptyStringSchema,
    canonicalKey: sourceServerNonEmptyStringSchema,
    reason: sourceServerNonEmptyStringSchema,
  })
  .strict();
export type SourceServerMigrationConflict = z.infer<typeof sourceServerMigrationConflictSchema>;

export const sourceServerMigrationReportRowSchema = z
  .object({
    migrationId: sourceServerNonEmptyStringSchema,
    workspacePath: sourceServerNonEmptyStringSchema,
    canonicalKey: sourceServerNonEmptyStringSchema,
    variantKeys: z.array(sourceServerNonEmptyStringSchema),
    status: z.enum(["running", "completed", "failed", "abandoned", "abandoned-diverged"]),
    phase: sourceServerNonEmptyStringSchema.optional(),
    errorCode: sourceServerNonEmptyStringSchema.optional(),
    taskBackupPath: sourceServerNonEmptyStringSchema.optional(),
    sessionBackupPath: sourceServerNonEmptyStringSchema.optional(),
    updatedAt: sourceServerTimestampSchema,
    abandonedAt: sourceServerTimestampSchema.optional(),
    abandonedTrigger: sourceServerNonEmptyStringSchema.optional(),
    conflicts: z.array(sourceServerMigrationConflictSchema),
  })
  .strict();
export type SourceServerMigrationReportRow = z.infer<typeof sourceServerMigrationReportRowSchema>;

export const sourceServerMigrationReportSchema = z
  .object({ rows: z.array(sourceServerMigrationReportRowSchema) })
  .strict();
export type SourceServerMigrationReport = z.infer<typeof sourceServerMigrationReportSchema>;

export const sourceServerMigrationPathActionSchema = z
  .object({
    workspacePath: sourceServerNonEmptyStringSchema,
    migrationId: sourceServerNonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerMigrationPathAction = z.infer<typeof sourceServerMigrationPathActionSchema>;

export const sourceServerResolveWorkspaceRequestSchema = z
  .object({
    workspacePath: sourceServerNonEmptyStringSchema,
    legacyRouteHint: sourceServerNonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceRequest = z.infer<
  typeof sourceServerResolveWorkspaceRequestSchema
>;

export const sourceServerResolveWorkspaceResultSchema = z
  .object({
    canonicalWorkspaceKey: sourceServerNonEmptyStringSchema,
    mergedKeys: z.array(sourceServerNonEmptyStringSchema),
    migrationId: sourceServerNonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceResult = z.infer<
  typeof sourceServerResolveWorkspaceResultSchema
>;

export type SourceServerDeclaredWorkspaceWire = z.infer<typeof serverRemoteWorkspaceInfoSchema>;
