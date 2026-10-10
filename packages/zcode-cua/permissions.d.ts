export type CuaPermissionState = "granted" | "stale" | "denied" | "unknown";

export interface CuaPermissionStatus {
  available?: true;
  platform?: string;
  grantOwner: string | null;
  owner?: { display_name?: string } | null;
  grantOwnerDisplayName?: string | null;
  accessibility: CuaPermissionState;
  accessibilityProbeOk?: boolean;
  screenRecording: CuaPermissionState;
  screenCaptureProbeOk?: boolean;
  idle?: boolean;
  reason?: string;
}

export interface CuaPermissionStatusUnavailable {
  available: false;
  reason: string;
  idle?: boolean;
  grantOwnerDisplayName?: string | null;
}

export type CuaPermissionStatusResult = CuaPermissionStatus | CuaPermissionStatusUnavailable;

export interface CuaPermissionStatusQueryOptions {
  probeScreenCapture?: boolean;
  [key: string]: unknown;
}

export interface CuaPermissionRestartResult {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CuaPermissionRestartOptions {
  onboardingSessionId?: string;
  reason?: string;
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface ICuaPermissionService {
  getStatus(
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CuaPermissionStatusQueryOptions,
  ): Promise<CuaPermissionStatusResult>;
  restartHelper(
    workspacePath?: string,
    workspaceIdentity?: string,
    options?: CuaPermissionRestartOptions,
  ): Promise<CuaPermissionRestartResult>;
}

export interface CuaDriverPermissionClient {
  callTool(toolName: string, argsJson: string): Promise<{ structuredJson?: string }>;
}

export interface CreateCuaDriverPermissionServiceOptions {
  client?: CuaDriverPermissionClient;
  platform?: string;
  grantOwnerDisplayName?: string;
}

export declare function projectCuaPermissionStatus(
  raw: unknown,
  options?: { platform?: string; grantOwnerDisplayName?: string },
): CuaPermissionStatusResult;

export declare function isCuaPermissionStatusAvailable(
  result: CuaPermissionStatusResult | null | undefined,
): result is CuaPermissionStatus;

export declare function shouldRunCuaScreenCaptureProbe(
  state: CuaPermissionState | undefined,
  options?: CuaPermissionStatusQueryOptions,
): boolean;

export declare function createCuaDriverPermissionService(
  options?: CreateCuaDriverPermissionServiceOptions,
): ICuaPermissionService;
