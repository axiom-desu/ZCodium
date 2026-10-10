import type { EmbeddedDriverConnection, EmbeddedDriverHostState } from "@trycua/cua-driver";

export interface ResolveCuaDriverBinaryPathOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  isPackaged?: boolean;
  existsSync?: (path: string) => boolean;
}

export declare function resolveCuaDriverBinaryPath(
  options?: ResolveCuaDriverBinaryPathOptions,
): string | undefined;

export interface CuaDriverHost {
  binaryPath: string;
  start(signal?: AbortSignal): Promise<EmbeddedDriverConnection>;
  stop(): Promise<void>;
  restart(signal?: AbortSignal): Promise<EmbeddedDriverConnection>;
  connection(): EmbeddedDriverConnection | undefined;
  state(): EmbeddedDriverHostState;
  waitForExit(generation: string, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}

export interface CreateEmbeddedCuaDriverHostOptions extends ResolveCuaDriverBinaryPathOptions {
  binaryPath?: string;
  hostBundleId?: string;
  driverModule?: unknown;
}

export declare function createEmbeddedCuaDriverHost(
  options?: CreateEmbeddedCuaDriverHostOptions,
): Promise<CuaDriverHost | undefined>;
