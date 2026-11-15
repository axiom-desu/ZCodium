import type { McpPort, McpServerConfig, McpServerStatus } from "@zcode/contracts";
import type { WorkspaceMcpTrustContract } from "./contract.js";

/** 准入包住 lease 而非 UI；subagent、旧连接和资源读取也必须经过同一权限边界。 */
export function guardPort(
  port: McpPort,
  authority: WorkspaceMcpTrustContract,
  signal?: AbortSignal,
  target?: { workingDirectory: string; workspaceIdentity: string },
): McpPort {
  const configurations = new Map<string, McpServerConfig>();
  const blocked = new Map<string, McpServerStatus>();
  let mutationTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const isClosed = () => closed || signal?.aborted === true;
  // 连接替换只有一个 owner；配置 A 的迟到握手不能覆盖配置 B 的执行映射。
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(() => {
      if (isClosed()) throw new Error("MCP port is closed");
      return operation();
    });
    mutationTail = result.catch(() => undefined);
    return result;
  };
  const blockedStatus = (config: McpServerConfig): McpServerStatus => ({
    status: config.enabled === false ? "disabled" : "untrusted",
    transport: config.type,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  });
  // 授权变化允许延迟到下次连接准入；连接内只查已有结果，避免逐次同步读配置。
  const isAdmitted = (name: string) =>
    !isClosed() && configurations.has(name) && !blocked.has(name);
  async function admitted(name: string): Promise<boolean> {
    const config = configurations.get(name);
    if (!config) return false;
    const allowed = config.enabled !== false && (await authority.allows(name, config));
    if (isClosed() || configurations.get(name) !== config) return false;
    if (allowed) {
      blocked.delete(name);
      return true;
    }
    blocked.set(name, blockedStatus(config));
    return false;
  }
  const requestMethods = new Set([
    "callTool",
    "readResource",
    "listResources",
    "listResourceTemplates",
    "subscribeResource",
    "unsubscribeResource",
  ]);
  return new Proxy(port, {
    get(raw, key) {
      if (key === "close")
        return async () => {
          closed = true;
          configurations.clear();
          blocked.clear();
          await raw.close();
        };
      if (key === "disconnectServer")
        return (name: string) =>
          mutate(async () => {
            configurations.delete(name);
            blocked.delete(name);
            return raw.disconnectServer(name);
          });
      if (key === "connectServer")
        return async (name: string, config: McpServerConfig, options: Parameters<McpPort["connectServer"]>[2] = {}) => {
          // 审核、摘要与传输使用同一不可变副本，调用方修改原对象不能批准 A 后执行 B。
          const frozen = JSON.parse(JSON.stringify(config)) as McpServerConfig;
          return mutate(async () => {
            configurations.set(name, frozen);
            // 工作区声明检查完成前默认拒绝；明确的用户/插件来源保持原准入语义。
            if (frozen.enabled === false || !frozen.source || frozen.source.kind === "workspace")
              blocked.set(name, blockedStatus(frozen));
            else blocked.delete(name);
            if (!(await admitted(name)) || isClosed()) {
              if (isClosed()) throw new Error("MCP port is closed");
              await raw.disconnectServer(name);
              return blocked.get(name)!;
            }
            return raw.connectServer(name, frozen, { ...options, ...target });
          });
        };
      if (key === "connectConfiguredServers")
        return async (
          servers: Record<string, McpServerConfig>,
          options: Parameters<McpPort["connectConfiguredServers"]>[1] = {},
        ) => {
          const frozen = JSON.parse(JSON.stringify(servers)) as Record<string, McpServerConfig>;
          return mutate(async () => {
            configurations.clear();
            blocked.clear();
            for (const [name, config] of Object.entries(frozen)) {
              configurations.set(name, config);
              if (config.enabled === false || !config.source || config.source.kind === "workspace")
                blocked.set(name, blockedStatus(config));
            }
            const accepted: Record<string, McpServerConfig> = {};
            const workspaceServers: Record<string, McpServerConfig> = {};
            for (const [name, config] of Object.entries(frozen)) {
              if (!(await admitted(name))) continue;
              if (
                config.source?.kind === "workspace" ||
                (!config.source && (await authority.inspect())[name])
              )
                workspaceServers[name] = config;
              else accepted[name] = config;
            }
            if (isClosed()) throw new Error("MCP port is closed");
            await raw.connectConfiguredServers(accepted, { ...options, ...target });
            // 普通 MCP 的慢握手不能让工作区授权检查提前；每个实际连接前再验一次。
            await Promise.all(
              Object.entries(workspaceServers).map(async ([name, config]) => {
                if ((await admitted(name)) && !isClosed())
                  await raw.connectServer(name, config, { ...options, ...target });
              }),
            );
            const statuses = { ...(await raw.status()), ...Object.fromEntries(blocked) };
            const tools = (await raw.listTools()).filter(
              (tool) => !blocked.has(tool.serverName) && configurations.has(tool.serverName),
            );
            return { statuses, tools };
          });
        };
      if (key === "status")
        return async () => {
          return { ...(await raw.status()), ...Object.fromEntries(blocked) };
        };
      if (key === "listTools")
        return async () => {
          const allowed = new Set<string>();
          for (const name of configurations.keys()) if (isAdmitted(name)) allowed.add(name);
          return (await raw.listTools()).filter((tool) => allowed.has(tool.serverName));
        };
      const method = Reflect.get(raw, key, raw);
      if (typeof method !== "function") return method;
      if (requestMethods.has(String(key)))
        return async (request: { serverName: string }, ...args: unknown[]) => {
          const observed = mutationTail;
          await observed;
          if (!isAdmitted(request.serverName) || observed !== mutationTail)
            throw new Error("workspace_mcp_pending_trust");
          return method.call(raw, request, ...args);
        };
      if (key === "pingServer")
        return async (name: string, ...args: unknown[]) => {
          const observed = mutationTail;
          await observed;
          return isAdmitted(name) && observed === mutationTail
            ? method.call(raw, name, ...args)
            : false;
        };
      if (key === "appConnectionSnapshot")
        return (name: string) => (blocked.has(name) ? null : method.call(raw, name));
      if (key === "waitForAppConnection")
        return async (name: string) => (isAdmitted(name) ? method.call(raw, name) : null);
      // 按 subscriber 释放只清理已有订阅；执行授权失败不能阻止 MCP App 生命周期收尾。
      return method.bind(raw);
    },
  });
}
