import type { CuaPermissionStatus } from "./permissions.js";

export interface HelperHealth {
  bundleId: string | null;
  pid: number | null;
}

/** Helper 传输凭据：agent env 注入给 MCP worker 的 socket + authority。 */
export interface CuaHelperTransportHandle {
  socketPath: string;
  pluginAuthority: string;
  [key: string]: unknown;
}

export interface CuaHelperHandle {
  socketPath: string;
  launchSocketPath?: string;
  pluginAuthority: string;
  helperAppPath?: string;
  bundleId?: string | null;
  pid?: number | null;
  [key: string]: unknown;
}

export interface CuaHelperTransportRestartOptions {
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface CuaHelperTransportRestartResult {
  handle: CuaHelperHandle;
  reused: boolean;
}

export interface CuaProductMcpServerResolverContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  [key: string]: unknown;
}

export interface CuaProductHelperHost {
  readonly running: boolean;
  readonly socketPath: string | null;
  readonly pluginAuthority: string | null;
  start(): Promise<CuaHelperHandle>;
  stop(): Promise<void>;
  restart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStartPreservingTransport?(
    restartOptions?: CuaHelperTransportRestartOptions,
  ): Promise<CuaHelperTransportRestartResult>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  checkHealth(timeoutMs?: number): Promise<HelperHealth>;
}

export type ManagedCuaProductHelperHost = CuaProductHelperHost;

export interface CuaProductMcpServerConfigLike {
  [key: string]: unknown;
}

/**
 * 解析 agent 侧的 CUA MCP server 列表：按 workspace 上下文补/改配置。
 * Windows Helper host 与 services 的 session 装配共用此契约。
 */
export interface CuaProductMcpServerResolver {
  resolveMcpServers<T>(
    servers: T[] | undefined,
    context?: CuaProductMcpServerResolverContext,
  ): Promise<T[] | undefined>;
  restart(): Promise<void>;
  restartAfterPermissionGrant(onboardingSessionId?: string): Promise<void>;
}

export interface CuaHelperHost extends CuaProductHelperHost {
  readonly reservedTransport: CuaHelperTransportHandle | undefined;
  waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  queryScreenCaptureProbe(): Promise<{ ok: boolean; reason?: string }>;
  queryScreenRecordingPreflight(): Promise<"granted" | "denied" | "unknown" | undefined>;
  queryPermissionStatus(): Promise<CuaPermissionStatusQueryReport>;
}

/** macOS Helper 的 permission_status broker 回报形状。 */
export interface CuaPermissionStatusQueryReport {
  grant_owner: string | null;
  owner?: { display_name?: string | null } | null;
  accessibility: CuaPermissionStatus["accessibility"];
  accessibility_probe?: { ok: boolean; classification?: string };
  screen_recording: CuaPermissionStatus["screenRecording"];
  screen_capture_probe?: { ok: boolean; classification?: string };
  [key: string]: unknown;
}

export interface ResolveBrokerSocketPathOptions {
  dir?: string;
  env?: Record<string, string | undefined>;
}

export declare const BROKER_SOCKET_ENV: string;
export declare const BROKER_UNAVAILABLE_ENV: string;
export declare const HELPER_ADDON_ENV: string;
export declare const WINDOWS_DEV_CONTROL_PROTOCOL: string;

export declare class CuaHelperError extends Error {
  code: string;
}

export declare function isCuaHelperError(value: unknown): value is CuaHelperError;

export declare function mintBrokerSocketPath(options?: { dir?: string }): string;

export declare function resolveBrokerSocketPath(options?: ResolveBrokerSocketPathOptions): string;

export declare function waitForCuaHelperStartup<T>(
  startup: Promise<T>,
  deadlineMs?: number,
): Promise<T>;

export declare function probeHelperHealth(
  socketPath: string,
  options?: { timeoutMs?: number },
): Promise<HelperHealth>;

export declare function isPotentialZCodeCuaAgentMcpServer(server: unknown): boolean;

export declare class CuaHelperLifecycleManager<Managed> {
  constructor(dispose?: (managed: Managed) => Promise<void> | void);
  acquire(options: {
    isAdmitted?: () => boolean;
    shouldRetainCurrent?: (current: Managed) => boolean;
    create: () => Managed | undefined;
  }): Promise<Managed | undefined>;
  peek(): Managed | undefined;
  readonly disposed: boolean;
  dispose(managed?: Managed): Promise<void>;
}

export declare class CuaProductHelperWorkspaceRegistry {
  setEnabled(context: CuaProductMcpServerResolverContext | undefined, enabled: boolean): void;
}

export declare function isOfficialCuaPluginEnabledForWorkspace(options: {
  env?: Record<string, string | undefined>;
  workingDirectory?: string;
}): boolean;

export declare function createCuaProductMcpServerResolver(
  host: unknown,
  options?: { hasActiveTurn?: () => boolean },
): CuaProductMcpServerResolver;
