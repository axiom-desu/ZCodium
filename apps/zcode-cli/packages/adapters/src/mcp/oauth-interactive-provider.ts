import { createHash } from "node:crypto";
import {
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import type { LocalhostOAuthCallbackServer } from "../auth/localhost-callback.js";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { publishCanonicalCredentials } from "./oauth-credentials.js";
import { publishPendingAuthorization } from "./oauth-lease.js";
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  type McpOAuthAuthorizationContext,
} from "./oauth-shared.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

interface InteractiveAuthorizationProviderInput {
  attemptId: string;
  baselineGeneration?: string;
  callbackServer: LocalhostOAuthCallbackServer;
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  keyPrefix: string;
  logger?: Logger;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  requestedScope?: string;
  serverName: string;
  state: string;
  transactionTtlMs: number;
}

/**
 * Phase 2 专用 OAuthClientProvider。
 *
 * 与 Phase 1 的纯 AuthProvider 相反，这里必须是完整 `OAuthClientProvider` 才能驱动 `auth()`；
 * 但它只在授权事务内存活，且：
 * - `clientInformation()` 只认静态配置 clientId，其余一律返回 undefined，强制 fresh DCR；
 * - `saveClientInformation()` 只写事务内存，绝不落盘；
 * - `tokens()` 恒为 undefined，绝不触发 refresh（refresh 是 Phase 1 的唯一职责）；
 * - PKCE verifier 只存内存：整个事务在同一进程、同一 lease 内完成，不存在 provider 重建。
 */
export class InteractiveAuthorizationProvider implements OAuthClientProvider {
  private readonly attemptId: string;
  private readonly baselineGeneration?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  /** 编排层算好的最终 scope（step-up 时为并集）；DCR 与 authorize 请求必须用同一个值。 */
  private readonly requestedScope?: string;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private readonly transactionTtlMs: number;
  private issuer?: string;
  private memoryCodeVerifier?: string;
  private memoryDiscoveryState?: OAuthDiscoveryState;
  private transactionClientInformation?: OAuthClientInformationMixed;

  constructor(input: InteractiveAuthorizationProviderInput) {
    this.attemptId = input.attemptId;
    this.baselineGeneration = input.baselineGeneration;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.requestedScope = input.requestedScope;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
    this.transactionTtlMs = input.transactionTtlMs;
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      // DCR 注册的 scope 与 authorize 请求的 scope 必须是同一个并集结果。
      // 若 DCR 只写 config scope，注册的 client 与后续按并集发起的授权请求不一致，
      // 严格授权服务器会拒绝或静默按注册值收敛。
      ...((this.requestedScope ?? this.config.scope)
        ? { scope: this.requestedScope ?? this.config.scope }
        : {}),
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    // 过去这里优先返回持久化的 DCR client，而它的 redirect_uris 锁死在
    // 注册当时的随机端口。授权请求随后带「旧 client_id + 新 redirect_uri」，授权服务器按
    // RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页，回调永不到达且重试永不自愈。
    // 返回 undefined 让 SDK 用当前存活 listener 的 URL 重新注册，失配从根上消除。
    return this.transactionClientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    // 只写事务内存。DCR client 只有与本次授权换到的 token 组成一对才有意义；单独落盘
    // 也会污染其他事务的 canonical pair。
    this.transactionClientInformation = clientInformation;
  }

  tokens(): undefined {
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = this.clientInformation();
    if (!clientInformation) {
      throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
    }
    const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
      clientInformation,
      ...(this.issuer ? { issuer: this.issuer } : {}),
      publishedBy: this.transactionId,
      tokens,
    });
    this.logger?.info("MCP OAuth credentials published", {
      event: "mcp.oauth.credentials.published",
      ...this.logContext(),
      clientIdHash: hashIdentifier(clientInformation.client_id),
      grantKind: "authorization_code",
      hasRefreshToken: Boolean(tokens.refresh_token),
      publishedGeneration: published.generation.slice(0, 12),
      status: "completed",
      tokenExpiresInSeconds: tokens.expires_in,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const context: McpOAuthAuthorizationContext = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl: this.redirectUrl,
      serverName: this.serverName,
    };
    // pending 与 attempt 绑定：删除按 attempt CAS，旧 leader 的 finally 不会抹掉新 leader 的
    // pending。TTL 只用于展示过期判断，不承担锁所有权语义。
    await publishPendingAuthorization(this.credentialStore, this.keyPrefix, {
      attemptId: this.attemptId,
      authorizationUrl: context.authorizationUrl,
      ...(this.baselineGeneration ? { baselineGeneration: this.baselineGeneration } : {}),
      expiresAt: Date.now() + this.transactionTtlMs,
      state: this.stateValue,
    });
    this.logger?.info("MCP OAuth authorization required", {
      event: "mcp.oauth.authorization.required",
      ...this.logContext(),
      callbackPort: Number(new URL(this.redirectUrl).port),
      status: "waiting",
    });
    await this.onAuthorizationRequired?.(context);
    // 默认只暴露 URL，等用户在设置页点击授权；自动拉起浏览器会打断当前操作。
    await this.openAuthorizationUrl?.(context);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
    }
    return this.memoryCodeVerifier;
  }

  saveAuthorizationServerUrl(authorizationServerUrl: string): void {
    this.issuer = authorizationServerUrl;
  }

  authorizationServerUrl(): string | undefined {
    return this.issuer;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // 事务内也留一份内存副本：code exchange 那一腿需要能读回 authorize 腿记录的
    // issuer，否则 SDK 抛 AuthorizationServerMismatchError。共享记录可能被别的进程改写或过期，
    // 内存副本保证同一事务内的 issuer 绑定稳定。
    this.memoryDiscoveryState = state;
    await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.memoryDiscoveryState) return this.memoryDiscoveryState;
    return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
  }

  private logContext(): Record<string, unknown> {
    return {
      credentialKeyPrefix: this.keyPrefix,
      mcpServerName: this.serverName,
      oauthAttemptId: this.attemptId.slice(0, 12),
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
    };
  }
}

function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
