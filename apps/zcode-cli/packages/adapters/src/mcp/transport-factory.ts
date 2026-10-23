import {
  ClientCredentialsProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { Logger, McpServerConfig } from "@zcode/contracts";
import { resolve } from "node:path";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import { createCredentialKeyPrefix, type McpOAuthRuntimeOptions } from "./oauth.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import { MCP_STDIO_STDERR_LOG_MAX_CHARS, type McpTransport } from "./adapter-types.js";
import {
  createBoundedTextBuffer,
  resolveAuthorizationCodeOAuthConfig,
  sanitizeMcpStdioStderr,
} from "./protocol.js";

export interface McpTransportHost {
  readonly clientName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly mcpOAuth?: McpOAuthRuntimeOptions;
  readonly network?: NetworkEgressEnvPolicy;
  readonly workingDirectory?: string;
  resolveCredentialStore(): SharedZCodeCredentialStore;
}

export async function createTransport(
  host: McpTransportHost,
  config: McpServerConfig,
  serverName: string,
  workingDirectory?: string,
): Promise<{ transport: McpTransport }> {
  if (config.type === "stdio") {
    return {
      transport: new ProcessTreeStdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd
          ? resolve(workingDirectory ?? host.workingDirectory ?? process.cwd(), config.cwd)
          : (workingDirectory ?? host.workingDirectory),
        env: {
          ...buildMcpStdioEnv({ env: host.env, network: host.network }),
          ...config.env,
        },
        stderr: "pipe",
      }),
    };
  }

  const fetch = createMcpTransportFetch({
    env: host.env,
    network: host.network,
  });
  if (config.type === "http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: createOAuthClientProvider(host, serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  return {
    transport: new SSEClientTransport(new URL(config.url), {
      authProvider: createOAuthClientProvider(host, serverName, config),
      fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    }),
  };
}

/**
 * 运行期 auth provider。
 *
 * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
 * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
 * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
 * `auth()`，绕过我们的 refresh 单飞锁。
 *
 * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
 * 交互授权只在 Phase 2 事务里发生。
 */
function createOAuthClientProvider(
  host: McpTransportHost,
  serverName: string,
  config: McpServerConfig,
): AuthProvider | OAuthClientProvider | undefined {
  if (config.type === "stdio") return undefined;
  const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (authorizationCodeOAuthConfig) {
    return createMcpOAuthTokenProvider({
      config: authorizationCodeOAuthConfig,
      credentialStore: host.resolveCredentialStore(),
      fetchFn: createMcpTransportFetch({ env: host.env, network: host.network }),
      keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
      ...(host.logger ? { logger: host.logger } : {}),
      serverName,
      serverUrl: config.url,
    });
  }
  if (config.oauth?.type === "client_credentials") {
    return new ClientCredentialsProvider({
      clientId: config.oauth.clientId,
      clientName: config.oauth.clientName ?? `${host.clientName}-${serverName}`,
      clientSecret: config.oauth.clientSecret,
      scope: config.oauth.scope,
    });
  }
  return undefined;
}

export function attachStdioLogging(
  host: McpTransportHost,
  name: string,
  transport: McpTransport,
): () => string | undefined {
  const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
  const stderr = (
    transport as {
      stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
    }
  ).stderr;
  stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer.append(text);
    host.logger?.debug("MCP stdio stderr", {
      event: "mcp.stdio.stderr",
      mcpServerName: name,
      stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
    });
  });
  return () => {
    const text = stderrBuffer.read();
    if (!text) return undefined;
    // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
    // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
    return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
  };
}
