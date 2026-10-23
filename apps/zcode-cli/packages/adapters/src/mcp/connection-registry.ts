import { createHash } from "node:crypto";
import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";
import type { McpServerRecord } from "./adapter-types.js";

export interface McpRegistryHost {
  readonly records: Map<string, McpServerRecord>;
  readonly connectionGenerations: Map<string, number>;
  readonly appConnectionListeners: Map<string, Set<() => void>>;
  readonly workingDirectory?: string;
}

export function createStatus(
  config: McpServerConfig,
  status: McpServerStatus["status"],
  extra: {
    authorization?: McpServerStatus["authorization"];
    error?: string;
    failureKind?: McpServerStatus["failureKind"];
    protocolEra?: McpServerStatus["protocolEra"];
    serverRequestId?: string;
    toolCount?: number;
  } = {},
): McpServerStatus {
  return {
    status,
    transport: config.type,
    toolCount: extra.toolCount ?? 0,
    updatedAt: new Date().toISOString(),
    authorization: extra.authorization,
    error: extra.error,
    failureKind: extra.failureKind,
    protocolEra: extra.protocolEra,
    serverRequestId: extra.serverRequestId,
  };
}

export function nextConnectionGeneration(host: McpRegistryHost, name: string): number {
  const generation = (host.connectionGenerations.get(name) ?? 0) + 1;
  host.connectionGenerations.set(name, generation);
  // 回调可能增删监听器，本次通知必须固定接收者。
  for (const listener of Array.from(host.appConnectionListeners.get(name) ?? [])) listener();
  return generation;
}

export function isCurrentConnection(
  host: McpRegistryHost,
  name: string,
  generation: number,
): boolean {
  return host.connectionGenerations.get(name) === generation;
}

export function updateCurrentRecord(
  host: McpRegistryHost,
  name: string,
  generation: number,
  patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
): void {
  if (!isCurrentConnection(host, name, generation)) return;
  const record = host.records.get(name);
  if (!record) return;
  Object.assign(record, patch);
}

export function updateCurrentRecordStatus(
  host: McpRegistryHost,
  name: string,
  generation: number,
  patch: Partial<McpServerStatus>,
): void {
  if (!isCurrentConnection(host, name, generation)) return;
  const record = host.records.get(name);
  if (!record) return;
  record.status = {
    ...record.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function onAppConnectionInvalidated(
  host: McpRegistryHost,
  name: string,
  listener: () => void,
): () => void {
  const listeners = host.appConnectionListeners.get(name) ?? new Set();
  listeners.add(listener);
  host.appConnectionListeners.set(name, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) host.appConnectionListeners.delete(name);
  };
}

export function appConnectionSnapshot(
  host: McpRegistryHost,
  name: string,
): { identity: string; generation: number } | null {
  const record = host.records.get(name);
  if (!record?.client || record.status.status !== "connected") return null;
  // 只向宿主输出摘要；配置中的凭据不进入协议或日志。属性排序避免配置序列化次序造成换源。
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  return {
    identity: createHash("sha256")
      .update(
        JSON.stringify([
          process.platform,
          process.execPath,
          host.workingDirectory ?? "",
          name,
          canonical(record.config),
        ]),
      )
      .digest("hex"),
    generation: host.connectionGenerations.get(name) ?? 0,
  };
}

export function statuses(host: McpRegistryHost): Record<string, McpServerStatus> {
  return Object.fromEntries(
    Array.from(host.records.entries()).map(([name, record]) => [name, record.status]),
  );
}
