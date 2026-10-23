import type { WorkspaceHookTrustRecord } from "@zcode/contracts";

export function trustKey(record: {
  workspaceIdentity: string;
  hookDeclarationDigest: string;
}): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

export function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
