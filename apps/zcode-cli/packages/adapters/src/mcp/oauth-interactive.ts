import { createHash, randomBytes } from "node:crypto";
import { auth, type FetchLike } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { loadCanonicalCredentials, type CanonicalCredentialSnapshot } from "./oauth-credentials.js";
import {
  deletePendingAuthorizationIfOwned,
  loadPendingAuthorization,
  tryAcquireAuthorizationLease,
} from "./oauth-lease.js";
import type { McpOAuthAuthorizationContext } from "./oauth-shared.js";
import { InteractiveAuthorizationProvider } from "./oauth-interactive-provider.js";
import { withTimeout } from "./timeout.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/** 授权事务的全局寿命。与 caller 等待预算（session 15s）无关，由 caller 侧独立收口。 */
export const MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const FOLLOWER_POLL_INTERVAL_MS = 500;

export type McpInteractiveAuthorizationOutcome =
  /** 本次调用完成了授权，凭据已发布。 */
  | { status: "authorized" }
  /** 另一个事务已完成授权（generation 已换代），直接回 Phase 1 重连即可。 */
  | { status: "already-authorized" }
  /** 事务仍在进行（本调用是 follower 或已达事务 TTL），授权 URL 可供展示。 */
  | { status: "pending"; authorizationUrl?: string }
  | { status: "failed"; error: unknown };

interface McpInteractiveAuthorizationInput {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  /** 403 step-up：unionScope 是 requiredScope 的严格超集时，refresh 无法扩权，必须强制重新授权。 */
  forceReauthorization?: boolean;
  keyPrefix: string;
  logger?: Logger;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  /** 编排层算好的最终 scope（config scope ∪ token.scope ∪ challenge scope）。 */
  requestedScope?: string;
  resourceMetadataUrl?: URL;
  serverName: string;
  serverUrl: string;
  signal?: AbortSignal;
  transactionTtlMs?: number;
}

/**
 * Phase 2：交互授权事务。
 *
 * 不创建任何 MCP transport。直接用 SDK 导出的 `auth()` 驱动 discovery → DCR → authorize →
 * code exchange，因此不存在「Phase 2 transport 必须销毁」的隐患：授权成功后调用方直接用
 * Phase 1 的纯 AuthProvider 重新建连即可。
 */
export async function runMcpInteractiveAuthorization(
  input: McpInteractiveAuthorizationInput,
): Promise<McpInteractiveAuthorizationOutcome> {
  const transactionTtlMs = input.transactionTtlMs ?? MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS;
  const baseline = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
  const baselineGeneration = baseline?.generation;

  const lease = await tryAcquireAuthorizationLease({
    credentialsFilePath: input.credentialStore.filePath,
    keyPrefix: input.keyPrefix,
  });
  if (!lease) {
    return await followAuthorization(input, baselineGeneration, transactionTtlMs);
  }

  try {
    // 锁内重读：等待 lease 期间别人可能已经完成授权。
    const current = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(current, baselineGeneration)) {
      return { status: "already-authorized" };
    }
    return await leadAuthorization(input, {
      attemptId: lease.attemptId,
      baselineGeneration,
      transactionTtlMs,
    });
  } finally {
    await deletePendingAuthorizationIfOwned(
      input.credentialStore,
      input.keyPrefix,
      lease.attemptId,
    ).catch(() => undefined);
    await lease.release();
  }
}

async function leadAuthorization(
  input: McpInteractiveAuthorizationInput,
  context: {
    attemptId: string;
    baselineGeneration?: string;
    transactionTtlMs: number;
  },
): Promise<McpInteractiveAuthorizationOutcome> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  // 每次授权都重新 listen(0)。彻底放弃端口复用：listener 在整个连接期长期存活，复用必撞；
  // fresh DCR 会把当前存活 listener 的 URL 写进 redirect_uris，端口变化不再导致失配。
  let callbackServer: LocalhostOAuthCallbackServer;
  try {
    callbackServer = await createLocalhostOAuthCallbackServer({ callbackPath, state });
  } catch (error) {
    // EACCES/EMFILE/ENFILE/EADDRNOTAVAIL 等一律按 leader 失败处理，不特殊处理 EADDRINUSE。
    input.logger?.warn("MCP OAuth callback listener failed", {
      event: "mcp.oauth.callback_listener.failed",
      ...logContext(input, state),
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
    return { status: "failed", error };
  }

  const provider = new InteractiveAuthorizationProvider({
    attemptId: context.attemptId,
    baselineGeneration: context.baselineGeneration,
    callbackServer,
    config: input.config,
    credentialStore: input.credentialStore,
    keyPrefix: input.keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.onAuthorizationRequired,
    openAuthorizationUrl: input.openAuthorizationUrl,
    requestedScope: input.requestedScope,
    serverName: input.serverName,
    state,
    transactionTtlMs: context.transactionTtlMs,
  });

  try {
    const redirected = await auth(provider, {
      serverUrl: input.serverUrl,
      ...(input.requestedScope ? { scope: input.requestedScope } : {}),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
      ...(input.forceReauthorization ? { forceReauthorization: true } : {}),
    });
    if (redirected === "AUTHORIZED") {
      // 静态配置 client 且服务器直接放行时可能不经过浏览器。
      return { status: "authorized" };
    }

    // 只有「等人点授权」这一段有超时。code exchange 一律等到 settle，不与超时竞速：
    // 否则可能在 token response 已返回、saveTokens 仍在进行时放锁，fencing 就漏了。
    const callback = await withTimeout(
      callbackServer.waitForCallback(),
      context.transactionTtlMs,
      `MCP server ${input.serverName} OAuth authorization timed out`,
      input.signal,
    );
    const callbackParams = new URL(callback.url).searchParams;
    const authorizationCode = callbackParams.get("code") ?? callback.code;
    const issuerParam = callbackParams.get("iss");
    await auth(provider, {
      serverUrl: input.serverUrl,
      authorizationCode,
      ...(issuerParam ? { iss: issuerParam } : {}),
      ...(input.requestedScope ? { scope: input.requestedScope } : {}),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    input.logger?.info("MCP OAuth authorization completed", {
      event: "mcp.oauth.authorization.completed",
      ...logContext(input, state),
      status: "completed",
    });
    return { status: "authorized" };
  } catch (error) {
    // 事务 TTL 到点时授权仍可能在浏览器里进行，但本 leader 已经放弃：把 listener 关掉，
    // 让下一次连接重新成为 leader，而不是留下一个不会被消费的回调端口。
    const published = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(published, context.baselineGeneration)) {
      return { status: "already-authorized" };
    }
    input.logger?.warn("MCP OAuth authorization failed", {
      event: "mcp.oauth.authorization.failed",
      ...logContext(input, state),
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
    return { status: "failed", error };
  } finally {
    await callbackServer.close().catch(() => undefined);
  }
}

async function followAuthorization(
  input: McpInteractiveAuthorizationInput,
  baselineGeneration: string | undefined,
  transactionTtlMs: number,
): Promise<McpInteractiveAuthorizationOutcome> {
  const deadline = Date.now() + transactionTtlMs;
  let projectedUrl: string | undefined;
  input.logger?.info("MCP OAuth authorization is already in progress elsewhere", {
    event: "mcp.oauth.authorization.following",
    ...logContext(input),
    status: "waiting",
  });

  while (Date.now() < deadline && !input.signal?.aborted) {
    const current = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(current, baselineGeneration)) return { status: "already-authorized" };

    const pending = await loadPendingAuthorization(input.credentialStore, input.keyPrefix);
    if (pending && pending.authorizationUrl !== projectedUrl) {
      // 设置页与 session 是独立 lease，leader 的 onAuthorizationRequired 回调对 follower
      // 不可见；follower 必须从共享 pending 键把同一个授权 URL 投影到自己的状态。
      projectedUrl = pending.authorizationUrl;
      await input.onAuthorizationRequired?.({
        authorizationUrl: pending.authorizationUrl,
        redirectUrl: "",
        serverName: input.serverName,
      });
    }
    await sleep(FOLLOWER_POLL_INTERVAL_MS, input.signal);
  }

  return { status: "pending", ...(projectedUrl ? { authorizationUrl: projectedUrl } : {}) };
}

function hasNewerCredentials(
  current: CanonicalCredentialSnapshot | undefined,
  baselineGeneration: string | undefined,
): boolean {
  return Boolean(current?.tokens && current.generation !== baselineGeneration);
}

function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

function logContext(
  input: McpInteractiveAuthorizationInput,
  state?: string,
): Record<string, unknown> {
  return {
    adapterInstanceId: input.adapterInstanceId,
    credentialKeyPrefix: input.keyPrefix,
    mcpServerName: input.serverName,
    ...(state
      ? { oauthStateId: createHash("sha256").update(state).digest("hex").slice(0, 16) }
      : {}),
    processId: process.pid,
  };
}

function sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
