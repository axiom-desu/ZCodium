import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  createConfig,
  ZCodeConfigFileSchema,
  type ConfigFactoryOptions,
} from "@zcode/adapters/config";
import { resolveWorkspaceHookTrustStorePath } from "@zcode/adapters/storage";
import type { McpServerConfig } from "@zcode/contracts";
import { sanitizeHookDisplayText } from "@zcode/core";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { WorkspaceMcpTrustContract, WorkspaceMcpTrustReview } from "./contract.js";
import { guardPort } from "./guard.js";


const STORE_NAME = "workspace-mcp-trust-v1.json";
const recordSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    serverName: z.string().min(1),
    declarationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    grantedAt: z.string().datetime(),
  })
  .strict();
const storeSchema = z
  .object({ schemaVersion: z.literal(1), records: z.array(recordSchema) })
  .strict();
type TrustRecord = z.infer<typeof recordSchema>;
type Declaration = { config: McpServerConfig; sourcePaths: string[]; declarationDigest: string };

/** 同一 Host 的用户存储是唯一授权 owner；项目 storage.dir 不能选择信任文件。 */
export function createWorkspaceMcpTrust(
  options: ConfigFactoryOptions & {
    workingDirectory: string;
    workspaceIdentity?: string;
  },
): WorkspaceMcpTrustContract {
  const workingDirectory = resolve(options.workingDirectory);
  const workspaceIdentity = options.workspaceIdentity?.trim() || workingDirectory;
  const storePath = async () =>
    join(
      dirname(
        await resolveWorkspaceHookTrustStorePath({
          userConfigPath: options.userConfigPath,
        }),
      ),
      STORE_NAME,
    );
  const digest = (name: string, config: McpServerConfig, sourcePaths: string[]) =>
    hash({
      version: 1,
      workspaceIdentity,
      workingDirectory,
      serverName: name,
      sourcePaths,
      config: executionConfig(config, workingDirectory),
    });
  async function discover(): Promise<{
    declarations: Record<string, Declaration>;
    serverSources: Record<string, "system" | "project" | "user" | "env" | "cli">;
    effectiveServers: Record<string, McpServerConfig>;
  }> {
    const result = createConfig({ ...options, workingDirectory });
    if (result.sources.project.diagnostics.some((item) => item.severity === "error")) {
      throw new Error("workspace_mcp_config_unreadable");
    }
    const declarations: Record<string, Declaration> = {};
    for (const [name, config] of Object.entries(result.config.mcp.servers)) {
      if (result.sources.mcp.serverSources[name] !== "project") continue;
      const sourcePaths = result.sources.project.paths;
      declarations[name] = {
        config,
        sourcePaths,
        declarationDigest: digest(name, config, sourcePaths),
      };
    }
    // Bug 原因：旧实现仅当项目标准配置没有 MCP 条目时才读 `.agents/mcp.json`，
    // 恶意仓库可以同时提供无害 `.zcodium` 条目让 fallback 声明永远不进审核集合，
    // 随后 `allows` 对缺省 source 放行，等价于任意本地命令执行。修复依据见
    // `.agents/specs/upstream-3.18-security-hardening.md`（B1）：fallback 始终参与发现，
    // 同名条目仍由项目/用户来源优先，fallback 不能覆盖它们。
    const path = join(workingDirectory, ".agents", "mcp.json");
    const raw = await readJson(path);
    if (raw !== undefined) {
      const object = z
        .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
        .parse(raw);
      for (const [name, value] of Object.entries(object.mcpServers ?? {})) {
        const source = result.sources.mcp.serverSources[name];
        if (source) continue;
        const parsed = ZCodeConfigFileSchema.safeParse({ mcp: { servers: { [name]: value } } });
        if (!parsed.success) continue;
        const config = parsed.data.mcp!.servers![name]!;
        const sourcePaths = [path];
        declarations[name] = {
          config,
          sourcePaths,
          declarationDigest: digest(name, config, sourcePaths),
        };
      }
    }
    return {
      declarations,
      serverSources: result.sources.mcp.serverSources,
      effectiveServers: result.config.mcp.servers,
    };
  }
  async function records(path?: string): Promise<TrustRecord[]> {
    const raw = await readJson(path ?? (await storePath()));
    return raw === undefined ? [] : storeSchema.parse(raw).records;
  }
  const matches = (record: TrustRecord, name: string, value: string) =>
    record.workspaceIdentity === workspaceIdentity &&
    record.serverName === name &&
    record.declarationDigest === value;
  async function inspect(): Promise<Record<string, WorkspaceMcpTrustReview>> {
    let declarations: Record<string, Declaration>;
    try {
      declarations = (await discover()).declarations;
    } catch {
      // 读取失败没有可批准的声明；执行 gate 仍拒绝，不能连带中断用户/插件 MCP 列表。
      return {};
    }
    if (Object.keys(declarations).length === 0) return {};
    let trusted: TrustRecord[] = [];
    try {
      trusted = await records();
    } catch {
      /* 损坏存储不能把已有声明显示成可信。 */
    }
    return Object.fromEntries(
      Object.entries(declarations).map(([name, entry]) => [
        name,
        {
          declarationDigest: entry.declarationDigest,
          configuredEnabled: entry.config.enabled !== false,
          transport: entry.config.type,
          sourcePaths: entry.sourcePaths,
          display: displayConfig(entry.config, workingDirectory),
          trusted: trusted.some((record) => matches(record, name, entry.declarationDigest)),
        },
      ]),
    );
  }
  async function allows(name: string, config: McpServerConfig): Promise<boolean> {
    // 只处理直接工作区配置。插件及 Host 内建 MCP 不继承同名项目声明。
    if (
      config.source?.kind === "plugin" ||
      config.source?.kind === "builtin" ||
      config.source?.kind === "user"
    )
      return true;
    try {
      const { declarations, serverSources, effectiveServers } = await discover();
      const entry = declarations[name];
      if (entry) {
        if (
          entry.config.enabled === false ||
          digest(name, config, entry.sourcePaths) !== entry.declarationDigest
        )
          return false;
        return (await records()).some((record) => matches(record, name, entry.declarationDigest));
      }
      // Bug 原因：缺省 source 的未知名字曾被当成“非工作区”无条件放行（fail open）。
      // 修复依据见安全 spec（B1）：只接受 createConfig 明确标注的用户/系统来源；
      // project 来源必须进入上面的工作区声明分支，未知名字默认拒绝。
      const source = serverSources[name];
      const configured = effectiveServers[name];
      // Bug 原因：同名 user/system 条目曾使任意运行载荷被放行；工作区可借名字执行另一条命令。
      // 修复依据：来源名只标识 authority，实际执行配置仍必须与该 authority 的有效配置精确一致。
      return (
        (source === "user" || source === "env" || source === "cli" || source === "system") &&
        configured !== undefined &&
        configured.enabled !== false &&
        digest(name, config, []) === digest(name, configured, [])
      );
    } catch {
      return false;
    }
  }
  const authority: WorkspaceMcpTrustContract = {
    inspect,
    allows,
    async decide(name, declarationDigest, trusted) {
      const path = await storePath();
      await withFileLock(path, async () => {
        const entry = (await discover()).declarations[name];
        if (!entry || entry.declarationDigest !== declarationDigest)
          throw new Error("workspace_mcp_declaration_changed");
        const current = await records(path);
        const next = current.filter((record) => !matches(record, name, declarationDigest));
        if (trusted)
          next.push({
            workspaceIdentity,
            serverName: name,
            declarationDigest,
            grantedAt: new Date().toISOString(),
          });
        await atomicWritePrivateTextFile(path, JSON.stringify({ schemaVersion: 1, records: next }));
      });
    },
    guard: (port, signal) =>
      guardPort(port, authority, signal, { workingDirectory, workspaceIdentity }),
  };
  return authority;
}

/** Windows 命令归一化：批准 `cmd /c npx` 后执行 npx 不能因摘要不同被误拒绝。 */
function normalizeMcpStdioCommand(command: string, args: string[] = []) {
  const isWin32 =
    (typeof process !== "undefined" && process.platform === "win32") ||
    (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
  const lowerCmd = command.toLowerCase();
  const unwrappedCommand = args[1];
  if (
    isWin32 &&
    (lowerCmd === "cmd" || lowerCmd === "cmd.exe") &&
    args[0] === "/c" &&
    unwrappedCommand
  ) {
    return { command: unwrappedCommand, args: args.slice(2) };
  }
  return { command, args };
}

function executionConfig(config: McpServerConfig, workingDirectory: string): unknown {
  const { enabled: _enabled, source: _source, ...execution } = config;
  return config.type === "stdio"
    ? {
        ...execution,
        ...normalizeMcpStdioCommand(config.command, config.args),
        env: config.env ?? {},
        cwd: config.cwd
          ? isAbsolute(config.cwd)
            ? config.cwd
            : resolve(workingDirectory, config.cwd)
          : workingDirectory,
      }
    : { ...execution, headers: config.headers ?? {} };
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        }
        return item;
      }),
    )
    .digest("hex");
}

function displayConfig(config: McpServerConfig, workingDirectory: string): string {
  if (config.type === "stdio")
    return sanitizeHookDisplayText(
      JSON.stringify(
        {
          command: sanitizeHookDisplayText([config.command, ...(config.args ?? [])].join(" ")),
          cwd: config.cwd ?? workingDirectory,
          env: Object.keys(config.env ?? {}),
        },
        null,
        2,
      ),
    );
  const url = new URL(config.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return JSON.stringify(
    {
      type: config.type,
      url: url.toString(),
      headers: Object.keys(config.headers ?? {}),
      oauth: config.oauth?.type,
    },
    null,
    2,
  );
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
