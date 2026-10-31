import { z } from "zod";
import type { RemoteTarget } from "../remoteTarget.js";
import { REMOTE_ASSET_INSTALL_MODES } from "../remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "../remoteResourcePackages.js";
import { wslUserSchema } from "../wslUserValidation.js";
import { sourceServerNonEmptyStringSchema, sourceServerTimestampSchema } from "./primitives.js";

/** 凭据键只做非空校验；不导出别名，避免与 shared validation 的 credentialKeySchema 重复。 */
const sourceServerCredentialKeySchema = sourceServerNonEmptyStringSchema;

export const sourceServerTransportKindSchema = z.enum(["ssh", "wsl", "docker"]);
export type SourceServerTransportKind = z.infer<typeof sourceServerTransportKindSchema>;

export const sshProfileTargetSchema = z
  .object({
    kind: z.literal("ssh"),
    host: sourceServerNonEmptyStringSchema,
    port: z.number().int().positive().max(65_535).optional(),
    username: sourceServerNonEmptyStringSchema,
    sshConfigAlias: sourceServerNonEmptyStringSchema.optional(),
    privateKeyPath: z.string().optional(),
    assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
    resourcePackages: z
      .object({
        selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
      })
      .strict()
      .optional(),
    passwordCredentialKey: sourceServerCredentialKeySchema.optional(),
    privateKeyPassphraseCredentialKey: sourceServerCredentialKeySchema.optional(),
  })
  .strict();

export const wslProfileTargetSchema = z
  .object({
    kind: z.literal("wsl"),
    distro: z.string().optional(),
    user: wslUserSchema.optional(),
  })
  .strict();

export const dockerProfileTargetSchema = z
  .object({
    kind: z.literal("docker"),
    container: sourceServerNonEmptyStringSchema,
  })
  .strict();

export const sourceServerProfileTargetSchema = z.discriminatedUnion("kind", [
  sshProfileTargetSchema,
  wslProfileTargetSchema,
  dockerProfileTargetSchema,
]);

export type SSHProfileTarget = z.infer<typeof sshProfileTargetSchema>;
export type WSLProfileTarget = z.infer<typeof wslProfileTargetSchema>;
export type DockerProfileTarget = z.infer<typeof dockerProfileTargetSchema>;
export type SourceServerProfileTarget = z.infer<typeof sourceServerProfileTargetSchema>;

/** 升级授权只绑定执行身份，不携带凭据或可变 Profile 内容。 */
export const sourceServerUpdateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: sourceServerNonEmptyStringSchema.toLowerCase(),
      port: z.number().int().positive().max(65_535).default(22),
      username: sourceServerNonEmptyStringSchema,
      sshConfigAlias: sourceServerNonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wsl"),
      distro: sourceServerNonEmptyStringSchema,
      user: wslUserSchema.refine((value) => value.length > 0),
    })
    .strict(),
  dockerProfileTargetSchema,
]);
export type SourceServerUpdateTarget = z.infer<typeof sourceServerUpdateTargetSchema>;

export function getSourceServerUpdateTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget {
  switch (target.kind) {
    case "ssh":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      });
    case "wsl":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        distro: target.distro,
        user: target.user,
      });
    case "docker":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        container: target.container,
      });
  }
}

export function isSameSourceServerUpdateTarget(
  left: Exclude<RemoteTarget, { kind: "server" }>,
  right: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (
    [left, right].some(
      (target) => target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim()),
    )
  )
    return false;
  return (
    JSON.stringify(getSourceServerUpdateTarget(left)) ===
    JSON.stringify(getSourceServerUpdateTarget(right))
  );
}

export const sourceServerUpdateRequestSchema = z
  .object({
    profileId: sourceServerNonEmptyStringSchema,
    force: z.boolean().optional(),
    expectedTarget: sourceServerUpdateTargetSchema.optional(),
  })
  .strict();
export type SourceServerUpdateRequest = z.input<typeof sourceServerUpdateRequestSchema>;

const connectionProfileBaseShape = {
  profileId: z.string().uuid(),
  sourceServerId: z.string().uuid().optional(),
  displayName: sourceServerNonEmptyStringSchema.optional(),
  lastConnectedAt: sourceServerTimestampSchema.optional(),
  lastConnectError: z.string().optional(),
  createdAt: sourceServerTimestampSchema,
  lifecycleState: z.enum(["active", "retired"]).default("active"),
  retiredReason: z.literal("source-reinstalled").optional(),
  retiredAt: sourceServerTimestampSchema.optional(),
};

export const connectionProfileSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("ssh"),
      target: sshProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("wsl"),
      target: wslProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("docker"),
      target: dockerProfileTargetSchema,
    })
    .strict(),
]);

export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
