export const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
export const ZIP_MAX_REDIRECTS = 5;
export const ZIP_DOWNLOAD_TIMEOUT_MS = 180_000;
export const ZIP_TEMP_PREFIX = "zcode-plugin-zip-";
export const ZIP_DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
export const ZIP_REQUIRED_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ResolvedZipPluginSourceRoot {
  cleanup: () => Promise<void>;
  path: string;
}

export interface ResolveZipPluginSourceInput {
  headers?: Record<string, string>;
  path?: string;
  sha256: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

export interface ResolveHttpZipSourceInput {
  headers?: Record<string, string>;
  path?: string;
  requireSingleRoot?: boolean;
  sha256?: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

export class PluginZipDownloadError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "PluginZipDownloadError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

export interface ZipExtractResult {
  topLevelSegments: Set<string>;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
