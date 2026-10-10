import type { ComputerUseCompatExecutor, ComputerUseRuntime, CuaDriverClient } from "./index.js";
import type { ICuaPermissionService } from "./permissions.js";

export interface PlatformPath {
  platform: string;
  session: string;
  desktop: string;
  path: "native" | "compat" | "unavailable";
  reason: string;
}

export interface GnomeProbes {
  gnomeShellVersion?: string | number;
  portalRemoteDesktopVersion?: string | number;
  winRectsVersion?: string | number;
}

export interface AssembleComputerUseRuntimeOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  probes?: GnomeProbes;
  client?: CuaDriverClient;
  socketPath?: string;
  connectDriver?: (socketPath?: string) => CuaDriverClient | undefined;
  compat?: ComputerUseCompatExecutor;
}

export interface AssembledComputerUseRuntime {
  path: PlatformPath;
  runtime: ComputerUseRuntime;
  requiresMacOsPermissions: boolean;
}

export declare function createCompatRuntimeOptions(options?: {
  client?: CuaDriverClient;
  helper?: unknown;
}): ComputerUseCompatExecutor;

export declare function probeGnomeEnvironment(): {
  gnomeShellVersion?: string;
  portalRemoteDesktopVersion?: string;
  winRectsVersion?: string;
};

export declare function describeCompatReadiness(probes?: GnomeProbes): {
  ready: boolean;
  needsExtension: boolean;
  reason: string;
  guidance?: string;
};

export declare function assembleComputerUseRuntime(
  options?: AssembleComputerUseRuntimeOptions,
): AssembledComputerUseRuntime;

export declare function assembleComputerUseRuntimeAsync(
  options?: Omit<AssembleComputerUseRuntimeOptions, "client" | "connectDriver"> & {
    driverModule?: unknown;
  },
): Promise<AssembledComputerUseRuntime>;

export declare function assembleCuaPermissionServiceAsync(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  socketPath?: string;
  driverModule?: unknown;
}): Promise<ICuaPermissionService>;
