/* eslint-disable max-lines -- Source/Profile/Workspace 三实体迁移与凭据重定向必须保持同一事务编排。 */
import { randomUUID } from "node:crypto";
import {
  type AppSettings,
  type ConnectionProfile,
  type DockerProfileTarget,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type SourceServerRecord,
  type SourceServerWorkspaceHistoryEntry,
  type SSHProfileTarget,
  type WSLProfileTarget,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";

interface SourceServerDirectoryOptions {
  settingService: ISettingService;
  credentialService: ICredentialService;
  createProfileId?: () => string;
  now?: () => number;
  logDebug?: (message: string) => void;
}

interface SourceServerDirectorySnapshot {
  profiles: ConnectionProfile[];
  servers: SourceServerRecord[];
  workspaceHistory: SourceServerWorkspaceHistoryEntry[];
}

interface SourceServerHandshakeRecord {
  sourceServerId: string;
  osUser?: string;
  hostname?: string;
  version: string;
  connectedAt?: number;
  workspaces?: readonly {
    workspacePath: string;
    workspaceIdentity: string;
    label?: string;
  }[];
}

interface SourceServerHandshakeResult {
  identityChanged: boolean;
  effectiveProfileId: string;
  effectiveProfile: ConnectionProfile;
}

type SourceProfileTarget = SSHProfileTarget | WSLProfileTarget | DockerProfileTarget;
type LegacyProfileTarget = Exclude<RemoteWorkspaceSessionEntry["target"], { kind: "server" }>;
type LegacyRemoteEntry = RemoteWorkspaceSessionEntry & { target: LegacyProfileTarget };

function isActiveProfile(profile: ConnectionProfile): boolean {
  return profile.lifecycleState !== "retired";
}

function routeKey(entry: LegacyRemoteEntry): string | null {
  const target = entry.target;
  switch (target.kind) {
    case "ssh":
      return [
        "ssh",
        target.host.trim().toLowerCase(),
        String(target.port ?? 22),
        target.username.trim(),
        target.privateKeyPath?.trim() ?? "",
      ].join("\u0000");
    case "wsl":
      return [
        "wsl",
        target.distro?.trim().toLowerCase() ?? "default",
        target.user?.trim().toLowerCase() ?? "",
      ].join("\u0000");
    case "docker":
      return ["docker", target.container.trim()].join("\u0000");
  }
}

function profileTargetIdentityKey(target: SourceProfileTarget): string {
  switch (target.kind) {
    case "ssh":
      return JSON.stringify({
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        privateKeyPath: target.privateKeyPath?.trim() ?? "",
      });
    case "wsl":
      return JSON.stringify({
        kind: "wsl",
        distro: target.distro?.trim() ?? "",
        user: target.user?.trim() ?? "",
      });
    case "docker":
      return JSON.stringify({ kind: "docker", container: target.container.trim() });
  }
}

function normalizeProfileTarget(target: LegacyProfileTarget): SourceProfileTarget {
  if (target.kind === "ssh") {
    return {
      kind: "ssh",
      host: target.host.trim().toLowerCase(),
      port: target.port ?? 22,
      username: target.username.trim(),
      ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      ...(target.privateKeyPath?.trim() ? { privateKeyPath: target.privateKeyPath.trim() } : {}),
      ...(target.resourcePackages ? { resourcePackages: target.resourcePackages } : {}),
    };
  }
  if (target.kind === "wsl") {
    return {
      kind: "wsl",
      ...(target.distro?.trim() ? { distro: target.distro.trim() } : {}),
      ...(target.user?.trim() ? { user: target.user.trim() } : {}),
    };
  }
  return { kind: "docker", container: target.container.trim() };
}

function buildConnectionProfile(input: {
  profileId: string;
  target: SourceProfileTarget;
  displayName: string;
  createdAt: number;
  lastConnectedAt?: number;
  lastConnectError?: string;
}): ConnectionProfile {
  const base = {
    profileId: input.profileId,
    displayName: input.displayName,
    createdAt: input.createdAt,
    lifecycleState: "active" as const,
    ...(input.lastConnectedAt !== undefined ? { lastConnectedAt: input.lastConnectedAt } : {}),
    ...(input.lastConnectError ? { lastConnectError: input.lastConnectError } : {}),
  };
  if (input.target.kind === "ssh") {
    return { ...base, transport: "ssh", target: input.target };
  }
  if (input.target.kind === "wsl") {
    return { ...base, transport: "wsl", target: input.target };
  }
  return { ...base, transport: "docker", target: input.target };
}

function replaceProfileTarget(
  profile: ConnectionProfile,
  target: SourceProfileTarget,
  displayName = profile.displayName,
): ConnectionProfile {
  const base = {
    ...profile,
    displayName,
  };
  if (target.kind === "ssh") {
    return { ...base, transport: "ssh", target };
  }
  if (target.kind === "wsl") {
    return { ...base, transport: "wsl", target };
  }
  return { ...base, transport: "docker", target };
}

function newCredentialKey(profileId: string, kind: "password" | "private-key-passphrase"): string {
  return `source-server:${profileId}:${kind}`;
}

export class SourceServerDirectory {
  private readonly createProfileId: () => string;
  private readonly now: () => number;
  private initializePromise: Promise<void> | null = null;
  private writeChain = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();

  public constructor(private readonly options: SourceServerDirectoryOptions) {
    this.createProfileId = options.createProfileId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  public onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public async initialize(): Promise<void> {
    if (!this.initializePromise) {
      const flight = this.enqueue(async () => {
        const settings = await this.options.settingService.get();
        if (settings.sourceServerDirectoryMigrationVersion !== 1) {
          await this.migrateLegacyRemoteEntries(settings);
        }
      });
      this.initializePromise = flight;
    }
    const flight = this.initializePromise;
    try {
      await flight;
    } catch (error) {
      // 失败 flight 不能永久缓存：临时 settings/credential IO 故障恢复后必须可重试。
      if (this.initializePromise === flight) this.initializePromise = null;
      throw error;
    }
  }

  public async snapshot(): Promise<SourceServerDirectorySnapshot> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    return {
      profiles: [...(settings.connectionProfiles ?? [])],
      servers: [...(settings.sourceServers ?? [])],
      workspaceHistory: [...(settings.sourceServerWorkspaceHistory ?? [])],
    };
  }

  /** 旧 route identity 优先于 renderer 传入的 fallback；不合并不同路径/身份。 */
  public async resolveLegacyWorkspaceIdentity(input: {
    profileId: string;
    workspacePath: string;
    fallback: string;
  }): Promise<string> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    const historical = (settings.sourceServerWorkspaceHistory ?? []).find(
      (entry) => entry.profileId === input.profileId && entry.workspacePath === input.workspacePath,
    )?.legacyWorkspaceIdentity;
    return historical?.trim() || input.fallback;
  }

  public async findProfile(profileId: string): Promise<ConnectionProfile | undefined> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    return (settings.connectionProfiles ?? []).find((profile) => profile.profileId === profileId);
  }

  public async preferredProfile(sourceServerId: string): Promise<ConnectionProfile | undefined> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    const server = (settings.sourceServers ?? []).find(
      (candidate) => candidate.sourceServerId === sourceServerId,
    );
    const profiles = (settings.connectionProfiles ?? []).filter(
      (profile) => profile.sourceServerId === sourceServerId && isActiveProfile(profile),
    );
    return (
      profiles.find((profile) => profile.profileId === server?.preferredProfileId) ??
      profiles.sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))[0]
    );
  }

  public async ensureProfile(
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options: { deferCredentials?: boolean } = {},
  ): Promise<ConnectionProfile> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const normalized = normalizeProfileTarget(target);
      const identityKey = profileTargetIdentityKey(normalized);
      const existing = (settings.connectionProfiles ?? []).find(
        (profile) =>
          isActiveProfile(profile) &&
          profile.transport === normalized.kind &&
          profileTargetIdentityKey(profile.target) === identityKey,
      );
      if (existing && options.deferCredentials) return existing;
      const profileId = existing?.profileId ?? this.createProfileId();
      const credentialMutation = options.deferCredentials
        ? { target: normalized, rollback: async () => undefined }
        : await this.persistProfileCredentials(profileId, target, existing?.target ?? normalized);

      const nextTarget: SourceProfileTarget =
        normalized.kind === "ssh" && credentialMutation.target.kind === "ssh"
          ? {
              ...normalized,
              ...(credentialMutation.target.passwordCredentialKey
                ? { passwordCredentialKey: credentialMutation.target.passwordCredentialKey }
                : {}),
              ...(normalized.privateKeyPath &&
              credentialMutation.target.privateKeyPassphraseCredentialKey
                ? {
                    privateKeyPassphraseCredentialKey:
                      credentialMutation.target.privateKeyPassphraseCredentialKey,
                  }
                : {}),
            }
          : credentialMutation.target;

      if (existing) {
        if (JSON.stringify(nextTarget) === JSON.stringify(existing.target)) return existing;
        const updated = replaceProfileTarget(existing, nextTarget);
        try {
          await this.persistSettings({
            connectionProfiles: (settings.connectionProfiles ?? []).map((profile) =>
              profile.profileId === existing.profileId ? updated : profile,
            ),
          });
          return updated;
        } catch (error) {
          await credentialMutation.rollback();
          throw error;
        }
      }

      const profile = buildConnectionProfile({
        profileId,
        target: nextTarget,
        displayName:
          nextTarget.kind === "ssh"
            ? (nextTarget.sshConfigAlias ?? nextTarget.host)
            : nextTarget.kind === "wsl"
              ? (nextTarget.distro ?? "WSL")
              : nextTarget.container,
        createdAt: this.now(),
      });
      try {
        await this.persistSettings({
          connectionProfiles: [...(settings.connectionProfiles ?? []), profile],
        });
        return profile;
      } catch (error) {
        await credentialMutation.rollback();
        throw error;
      }
    });
  }

  public async resolveProfileTarget(
    profile: ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>> {
    if (profile.target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(profile.target.distro ? { distro: profile.target.distro } : {}),
        ...(profile.target.user ? { user: profile.target.user } : {}),
      };
    }
    if (profile.target.kind === "docker") {
      return { kind: "docker", container: profile.target.container };
    }
    const target = profile.target;
    const passwordKey = target.passwordCredentialKey;
    const passphraseKey = target.privateKeyPath
      ? target.privateKeyPassphraseCredentialKey
      : undefined;
    const [password, passphrase] = await Promise.all([
      passwordKey ? this.options.credentialService.load(passwordKey) : Promise.resolve(null),
      passphraseKey ? this.options.credentialService.load(passphraseKey) : Promise.resolve(null),
    ]);
    // 已固定 profile 引用缺失值时必须 typed 要求交互凭据，不能静默降级为无认证。
    if (passwordKey && password === null) {
      throw Object.assign(
        new Error(`Connection Profile requires interactive credentials: ${profile.profileId}`),
        { code: "credentials-required" },
      );
    }
    if (passphraseKey && passphrase === null) {
      throw Object.assign(
        new Error(`Connection Profile requires interactive credentials: ${profile.profileId}`),
        { code: "credentials-required" },
      );
    }
    return {
      kind: "ssh",
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
      ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
      ...(target.resourcePackages ? { resourcePackages: target.resourcePackages } : {}),
      ...(password !== null ? { password } : {}),
      ...(passphrase !== null ? { privateKeyPassphrase: passphrase } : {}),
    };
  }

  public async recordHandshake(
    profileId: string,
    handshake: SourceServerHandshakeRecord,
  ): Promise<SourceServerHandshakeResult> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = settings.connectionProfiles ?? [];
      const profile = profiles.find((candidate) => candidate.profileId === profileId);
      if (!profile) throw new Error(`Unknown Connection Profile: ${profileId}`);
      const now = handshake.connectedAt ?? this.now();
      const identityChanged = Boolean(
        profile.sourceServerId && profile.sourceServerId !== handshake.sourceServerId,
      );
      const servers = settings.sourceServers ?? [];
      const existingServer = servers.find(
        (server) => server.sourceServerId === handshake.sourceServerId,
      );
      const declaredWorkspaces = (handshake.workspaces ?? []).map((workspace) => ({
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        ...(workspace.label ? { label: workspace.label } : {}),
      }));
      const displayName =
        existingServer?.displayName ||
        (profile.target.kind === "ssh"
          ? (profile.target.sshConfigAlias ?? handshake.hostname ?? handshake.sourceServerId)
          : handshake.hostname || handshake.sourceServerId);
      const nextServer: SourceServerRecord = {
        sourceServerId: handshake.sourceServerId,
        displayName,
        ...(handshake.osUser ? { osUser: handshake.osUser } : {}),
        ...(handshake.hostname ? { hostname: handshake.hostname } : {}),
        lastSeenVersion: handshake.version,
        lastOnlineAt: now,
        preferredProfileId: existingServer?.preferredProfileId ?? profileId,
        installState: existingServer?.installState ?? "installed",
        declaredWorkspaces:
          declaredWorkspaces.length > 0
            ? declaredWorkspaces
            : (existingServer?.declaredWorkspaces ?? []),
      };
      const nextProfile = {
        ...profile,
        sourceServerId: handshake.sourceServerId,
        lastConnectedAt: now,
        lastConnectError: undefined,
      } as ConnectionProfile;
      await this.persistSettings({
        sourceServers: [
          ...servers.filter((server) => server.sourceServerId !== handshake.sourceServerId),
          nextServer,
        ],
        connectionProfiles: profiles.map((candidate) =>
          candidate.profileId === profileId ? nextProfile : candidate,
        ),
      });
      return {
        identityChanged,
        effectiveProfileId: profileId,
        effectiveProfile: nextProfile,
      };
    });
  }

  public async recordLastOnline(sourceServerId: string, timestamp: number): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      await this.persistSettings({
        sourceServers: (settings.sourceServers ?? []).map((server) =>
          server.sourceServerId === sourceServerId
            ? { ...server, lastOnlineAt: timestamp }
            : server,
        ),
      });
    });
  }

  public async recordWorkspaceOpen(input: {
    profileId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    legacyWorkspaceIdentity?: string;
    sourceServerId?: string;
    lastOpenedAt?: number;
  }): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const history = (settings.sourceServerWorkspaceHistory ?? []).filter(
        (entry) =>
          !(
            entry.profileId === input.profileId &&
            entry.workspacePath === input.workspacePath &&
            (entry.workspaceIdentity ?? undefined) === (input.workspaceIdentity ?? undefined)
          ),
      );
      history.push({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.legacyWorkspaceIdentity
          ? { legacyWorkspaceIdentity: input.legacyWorkspaceIdentity }
          : {}),
        profileId: input.profileId,
        ...(input.sourceServerId ? { sourceServerId: input.sourceServerId } : {}),
        lastOpenedAt: input.lastOpenedAt ?? this.now(),
      });
      await this.persistSettings({
        sourceServerWorkspaceHistory: history.sort(
          (left, right) => left.lastOpenedAt - right.lastOpenedAt,
        ),
      });
    });
  }

  public async renameSource(sourceServerId: string, displayName: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const servers = settings.sourceServers ?? [];
      if (!servers.some((server) => server.sourceServerId === sourceServerId)) {
        throw new Error(`Unknown Source Server: ${sourceServerId}`);
      }
      await this.persistSettings({
        sourceServers: servers.map((server) =>
          server.sourceServerId === sourceServerId ? { ...server, displayName } : server,
        ),
      });
    });
  }

  public async renameProfile(profileId: string, displayName: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = settings.connectionProfiles ?? [];
      if (!profiles.some((profile) => profile.profileId === profileId)) {
        throw new Error(`Unknown Connection Profile: ${profileId}`);
      }
      await this.persistSettings({
        connectionProfiles: profiles.map((profile) =>
          profile.profileId === profileId ? { ...profile, displayName } : profile,
        ),
      });
    });
  }

  /**
   * 更新 profile 元数据。认证 secret 只通过 credential port 写入：
   * 新值先落盘，settings 提交成功后才清理旧 key；任一步失败恢复新 key 并保留旧 key 可用。
   */
  public async updateProfile(input: {
    profileId: string;
    profileDisplayName: string;
    sourceDisplayName?: string;
    target: Exclude<RemoteTarget, { kind: "server" }>;
  }): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = settings.connectionProfiles ?? [];
      const profile = profiles.find((candidate) => candidate.profileId === input.profileId);
      if (!profile) throw new Error(`Unknown Connection Profile: ${input.profileId}`);
      const normalized = normalizeProfileTarget(input.target);
      const mutation = await this.persistProfileCredentials(
        profile.profileId,
        input.target,
        profile.target,
      );
      const nextTarget: SourceProfileTarget =
        normalized.kind === "ssh" && mutation.target.kind === "ssh"
          ? {
              ...normalized,
              ...(mutation.target.passwordCredentialKey
                ? { passwordCredentialKey: mutation.target.passwordCredentialKey }
                : {}),
              ...(mutation.target.privateKeyPassphraseCredentialKey
                ? {
                    privateKeyPassphraseCredentialKey:
                      mutation.target.privateKeyPassphraseCredentialKey,
                  }
                : {}),
            }
          : mutation.target;
      const obsoleteKeys =
        profile.target.kind === "ssh"
          ? [
              ...(profile.target.passwordCredentialKey &&
              profile.target.passwordCredentialKey !==
                (nextTarget.kind === "ssh" ? nextTarget.passwordCredentialKey : undefined)
                ? [profile.target.passwordCredentialKey]
                : []),
              ...(profile.target.privateKeyPassphraseCredentialKey &&
              profile.target.privateKeyPassphraseCredentialKey !==
                (nextTarget.kind === "ssh"
                  ? nextTarget.privateKeyPassphraseCredentialKey
                  : undefined)
                ? [profile.target.privateKeyPassphraseCredentialKey]
                : []),
            ]
          : [];
      const servers = settings.sourceServers ?? [];
      try {
        await this.persistSettings({
          connectionProfiles: profiles.map((candidate) =>
            candidate.profileId === profile.profileId
              ? replaceProfileTarget(candidate, nextTarget, input.profileDisplayName)
              : candidate,
          ),
          ...(input.sourceDisplayName && profile.sourceServerId
            ? {
                sourceServers: servers.map((server) =>
                  server.sourceServerId === profile.sourceServerId
                    ? { ...server, displayName: input.sourceDisplayName! }
                    : server,
                ),
              }
            : {}),
        });
      } catch (error) {
        await mutation.rollback();
        throw error;
      }
      // settings 已提交；旧 credential key 现在才可清理，失败只留下 unreachable key。
      for (const key of obsoleteKeys) {
        await this.options.credentialService.delete(key).catch(() => undefined);
      }
    });
  }

  public async setPreferredProfile(sourceServerId: string, profileId: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const servers = settings.sourceServers ?? [];
      if (!servers.some((server) => server.sourceServerId === sourceServerId)) {
        throw new Error(`Unknown Source Server: ${sourceServerId}`);
      }
      const profiles = settings.connectionProfiles ?? [];
      if (
        !profiles.some(
          (profile) => profile.profileId === profileId && profile.sourceServerId === sourceServerId,
        )
      ) {
        throw new Error(`Profile ${profileId} does not belong to Source ${sourceServerId}`);
      }
      await this.persistSettings({
        sourceServers: servers.map((server) =>
          server.sourceServerId === sourceServerId
            ? { ...server, preferredProfileId: profileId }
            : server,
        ),
      });
    });
  }

  public async removeProfile(profileId: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId,
      );
      if (!profile) return;
      const credentialKeys =
        profile.target.kind === "ssh"
          ? [
              profile.target.passwordCredentialKey,
              profile.target.privateKeyPassphraseCredentialKey,
            ].filter((key): key is string => Boolean(key))
          : [];
      // 先提交 settings（profile 删除），成功后才清理 credential；settings 失败则旧 profile 完整可用。
      await this.persistSettings({
        connectionProfiles: (settings.connectionProfiles ?? []).filter(
          (candidate) => candidate.profileId !== profileId,
        ),
        sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
          (entry) => entry.profileId !== profileId,
        ),
        ...(profile.sourceServerId
          ? {
              sourceServers: (settings.sourceServers ?? []).map((server) =>
                server.sourceServerId === profile.sourceServerId &&
                server.preferredProfileId === profileId
                  ? { ...server, preferredProfileId: undefined }
                  : server,
              ),
            }
          : {}),
      });
      for (const key of credentialKeys) {
        await this.options.credentialService.delete(key).catch(() => undefined);
      }
    });
  }

  public async removeSource(sourceServerId: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const removedProfiles = (settings.connectionProfiles ?? []).filter(
        (profile) => profile.sourceServerId === sourceServerId,
      );
      await this.persistSettings({
        sourceServers: (settings.sourceServers ?? []).filter(
          (server) => server.sourceServerId !== sourceServerId,
        ),
        connectionProfiles: (settings.connectionProfiles ?? []).filter(
          (profile) => profile.sourceServerId !== sourceServerId,
        ),
        sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
          (entry) => entry.sourceServerId !== sourceServerId,
        ),
      });
      for (const profile of removedProfiles) {
        if (profile.target.kind !== "ssh") continue;
        for (const key of [
          profile.target.passwordCredentialKey,
          profile.target.privateKeyPassphraseCredentialKey,
        ]) {
          if (key) await this.options.credentialService.delete(key).catch(() => undefined);
        }
      }
    });
  }

  public async markSourceUninstalled(profileId: string): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId,
      );
      if (!profile?.sourceServerId) return;
      await this.persistSettings({
        sourceServers: (settings.sourceServers ?? []).map((server) =>
          server.sourceServerId === profile.sourceServerId
            ? { ...server, installState: "uninstalled" }
            : server,
        ),
      });
    });
  }

  private async migrateLegacyRemoteEntries(settings: AppSettings): Promise<void> {
    const previousCredentials = new Map<string, string | null>();
    try {
      await this.persistLegacyRemoteEntries(settings, previousCredentials);
    } catch (error) {
      // 迁移先写新 credential key、后提交 settings；settings 失败必须恢复本轮新 key，
      // 旧 key 全程未动，因此旧 lastWorkspaceSession 继续可用并可重试。
      await this.restoreCredentials(previousCredentials);
      throw error;
    }
  }

  private async persistLegacyRemoteEntries(
    settings: AppSettings,
    previousCredentials: Map<string, string | null>,
  ): Promise<void> {
    const remoteEntries = (settings.lastWorkspaceSession ?? []).filter(
      (entry): entry is LegacyRemoteEntry =>
        entry.kind === "remote" && entry.target.kind !== "server",
    );
    const groups = new Map<string, LegacyRemoteEntry[]>();
    for (const entry of remoteEntries) {
      const key = routeKey(entry);
      if (!key) continue;
      const values = groups.get(key) ?? [];
      values.push(entry);
      groups.set(key, values);
    }

    const profiles: ConnectionProfile[] = [];
    const workspaceHistory: SourceServerWorkspaceHistoryEntry[] = [];
    const shouldMigrateProfiles = !settings.connectionProfiles?.length;
    for (const entries of groups.values()) {
      // 不同旧 route 即便指向同一路径也保持独立 profile/identity；这里绝不按路径合并。
      const ordered = [...entries].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      const latest = ordered[0]!;
      const profileId = this.createProfileId();
      const target = shouldMigrateProfiles
        ? await this.migrateProfileTarget(
            profileId,
            latest.target,
            previousCredentials,
            ordered.map((entry) => entry.target),
          )
        : normalizeProfileTarget(latest.target);
      profiles.push(
        buildConnectionProfile({
          profileId,
          target,
          displayName:
            target.kind === "ssh"
              ? (target.sshConfigAlias ?? target.host)
              : target.kind === "wsl"
                ? (target.distro ?? "WSL")
                : target.container,
          createdAt: Math.min(...entries.map((entry) => entry.lastOpenedAt)),
          ...(latest.lastConnectionStatus === "connected"
            ? { lastConnectedAt: latest.lastOpenedAt }
            : {}),
          ...(latest.lastConnectionError ? { lastConnectError: latest.lastConnectionError } : {}),
        }),
      );
      for (const entry of entries) {
        workspaceHistory.push({
          workspacePath: entry.workspacePath,
          ...(entry.workspaceIdentity ? { legacyWorkspaceIdentity: entry.workspaceIdentity } : {}),
          profileId,
          lastOpenedAt: entry.lastOpenedAt,
        });
      }
    }

    await this.persistSettings({
      sourceServers: settings.sourceServers ?? [],
      connectionProfiles: settings.connectionProfiles?.length
        ? settings.connectionProfiles
        : profiles,
      sourceServerWorkspaceHistory: settings.sourceServerWorkspaceHistory?.length
        ? settings.sourceServerWorkspaceHistory
        : workspaceHistory.sort((left, right) => left.lastOpenedAt - right.lastOpenedAt),
      sourceServerDirectoryMigrationVersion: 1,
    });
  }

  private async migrateProfileTarget(
    profileId: string,
    target: LegacyProfileTarget,
    previousCredentials: Map<string, string | null>,
    credentialSources: readonly LegacyProfileTarget[] = [target],
  ): Promise<SourceProfileTarget> {
    if (target.kind === "ssh") {
      const passwordKey = newCredentialKey(profileId, "password");
      const passphraseKey = newCredentialKey(profileId, "private-key-passphrase");
      const passwordCopied = await this.copyFirstAvailableCredential(
        credentialSources.flatMap((candidate) =>
          candidate.kind === "ssh" && candidate.passwordCredentialKey
            ? [candidate.passwordCredentialKey]
            : [],
        ),
        passwordKey,
        previousCredentials,
      );
      // 顺序等待两类凭据：并行 reject 时迟到 save 可能越过 rollback。
      const passphraseCopied = target.privateKeyPath
        ? await this.copyFirstAvailableCredential(
            credentialSources.flatMap((candidate) =>
              candidate.kind === "ssh" &&
              candidate.privateKeyPath &&
              candidate.privateKeyPassphraseCredentialKey
                ? [candidate.privateKeyPassphraseCredentialKey]
                : [],
            ),
            passphraseKey,
            previousCredentials,
          )
        : false;
      return {
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(passwordCopied ? { passwordCredentialKey: passwordKey } : {}),
        ...(passphraseCopied ? { privateKeyPassphraseCredentialKey: passphraseKey } : {}),
      };
    }
    if (target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro.trim() } : {}),
        ...(target.user ? { user: target.user.trim() } : {}),
      };
    }
    return { kind: "docker", container: target.container.trim() };
  }

  private async persistProfileCredentials(
    profileId: string,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    profileTarget: SourceProfileTarget,
  ): Promise<{ target: SourceProfileTarget; rollback: () => Promise<void> }> {
    if (target.kind !== "ssh" || profileTarget.kind !== "ssh") {
      return { target: profileTarget, rollback: async () => undefined };
    }
    const passwordKey = target.password?.length
      ? (profileTarget.passwordCredentialKey ?? newCredentialKey(profileId, "password"))
      : profileTarget.passwordCredentialKey;
    const passphraseKey = target.privateKeyPassphrase?.length
      ? (profileTarget.privateKeyPassphraseCredentialKey ??
        newCredentialKey(profileId, "private-key-passphrase"))
      : profileTarget.privateKeyPassphraseCredentialKey;
    const writes = [
      ...(target.password?.length && passwordKey
        ? [{ key: passwordKey, value: target.password }]
        : []),
      ...(target.privateKeyPassphrase?.length && passphraseKey
        ? [{ key: passphraseKey, value: target.privateKeyPassphrase }]
        : []),
    ];
    const previous = new Map<string, string | null>();
    try {
      for (const write of writes) {
        previous.set(write.key, await this.options.credentialService.load(write.key));
        await this.options.credentialService.save(write.key, write.value);
      }
    } catch (error) {
      await this.restoreCredentials(previous);
      throw error;
    }
    const nextTarget: SSHProfileTarget = {
      ...profileTarget,
      ...(passwordKey ? { passwordCredentialKey: passwordKey } : {}),
      ...(passphraseKey ? { privateKeyPassphraseCredentialKey: passphraseKey } : {}),
    };
    const changed =
      nextTarget.passwordCredentialKey !== profileTarget.passwordCredentialKey ||
      nextTarget.privateKeyPassphraseCredentialKey !==
        profileTarget.privateKeyPassphraseCredentialKey;
    return {
      target: changed ? nextTarget : profileTarget,
      rollback: async () => await this.restoreCredentials(previous),
    };
  }

  private async copyFirstAvailableCredential(
    sourceKeys: readonly string[],
    destinationKey: string,
    previousCredentials?: Map<string, string | null>,
  ): Promise<boolean> {
    for (const sourceKey of sourceKeys) {
      const value = await this.options.credentialService.load(sourceKey);
      if (value === null) continue;
      if (previousCredentials && !previousCredentials.has(destinationKey)) {
        previousCredentials.set(
          destinationKey,
          await this.options.credentialService.load(destinationKey),
        );
      }
      await this.options.credentialService.save(destinationKey, value);
      return true;
    }
    return false;
  }

  private async restoreCredentials(previous: ReadonlyMap<string, string | null>): Promise<void> {
    await Promise.all(
      [...previous].map(async ([key, value]) => {
        if (value === null) await this.options.credentialService.delete(key);
        else await this.options.credentialService.save(key, value);
      }),
    );
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async persistSettings(patch: Partial<AppSettings>): Promise<void> {
    await this.options.settingService.update(patch);
    for (const listener of this.changeListeners) listener();
  }
}
