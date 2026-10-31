import {
  BoundedResponseBodyError,
  CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES,
  classifyConversationShareError,
  conversationShareErrorEnvelopeSchema,
  conversationSharePreviewDataSchema,
  conversationShareRequestIdSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeBoundedResponseBodyText,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  parseConversationSharePathname,
  readBoundedResponseBody,
  type ConversationShareErrorKind,
  type ConversationSharePreview,
  type Locale,
} from "@zcode/shared";

const SHARE_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/u;

/**
 * 归一化后会被 URL 解析器当作路径段的整段点号：`.` / `..`（含 `%2e` 解码变体）。
 * 只拒绝整段相等，`a..b`、`.abc`、`abc.` 这类合法 code 里的点号必须原样保留。
 */
function isDotSegment(code: string): boolean {
  return code === "." || code === "..";
}

export type ConversationSharePreviewErrorKind = ConversationShareErrorKind;

export class ConversationSharePreviewClientError extends Error {
  readonly kind: ConversationSharePreviewErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly requestId?: string;

  constructor(options: {
    kind: ConversationSharePreviewErrorKind;
    message: string;
    status?: number;
    code?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationSharePreviewClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = conversationShareRequestIdSchema.safeParse(options.requestId);
    if (requestId.success) this.requestId = requestId.data;
  }
}

/** 只接受 URL-safe 的分享 code；拒绝任何路径分隔符、点段或协议片段。 */
export function isSafeConversationShareCode(value: string): boolean {
  // `encodeURIComponent("..")` 仍是 `..`，URL 解析器会把 `/shares/../preview` 折叠成
  // `/preview`。所以 `.`/`..` 必须在发请求前按整段拒绝，而不是靠改写 endpoint 容忍。
  return SHARE_CODE_PATTERN.test(value) && !isDotSegment(value);
}

export function parseConversationShareRoute(pathname: string): string | null {
  const parsed = parseConversationSharePathname(pathname);
  if (!parsed) return null;
  let code: string;
  try {
    // 先解码再判定：`%2e%2e`/`.%2e` 这类编码变体解码后同样是 `..`，不能因为仍是
    // 字面点号加百分号就放过。解码出来的其它点号位置不重写、不归一化。
    code = decodeURIComponent(parsed.rawCode);
  } catch {
    return null;
  }
  return isSafeConversationShareCode(code) ? code : null;
}

/** 页面语言由路径前缀决定：/cn/share 中文，裸 /share 英文；非分享路径回退到浏览器语言。 */
export function resolveConversationShareRouteLocale(pathname: string): Locale {
  const parsed = parseConversationSharePathname(pathname);
  if (parsed) return parsed.locale;
  return /^zh(?:-|$)/iu.test(navigator.language) ? "zh-CN" : "en-US";
}

/** 只判断「是否归分享页处理」；形状不合法的留给 code 解析报 invalid_contract。 */
export function isConversationSharePath(pathname: string): boolean {
  return (
    pathname === "/cn/share" ||
    pathname.startsWith("/cn/share/") ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}

interface ConversationSharePreviewDiagnostics {
  info(event: string, details: Record<string, unknown>): void;
  warn(event: string, details: Record<string, unknown>): void;
}

// 日志只保留脱敏目标与传输元数据，禁止记录 share code、JWT、响应正文或 Signed URL。
const DEFAULT_DIAGNOSTICS: ConversationSharePreviewDiagnostics = {
  info(event, details) {
    console.info("[conversation-share-web]", event, details);
  },
  warn(event, details) {
    console.warn("[conversation-share-web]", event, details);
  },
};

const successEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationSharePreviewDataSchema,
);

function limitExceededError(options: {
  status: number;
  requestId: string | undefined;
  message: string;
}): ConversationSharePreviewClientError {
  return new ConversationSharePreviewClientError({
    kind: "limit_exceeded",
    message: options.message,
    status: options.status,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
}

/**
 * 有界读取预览正文：共享读取器负责 Content-Length 与分块累计，超限会取消底层流。
 * 上限来自公开投影合同（`CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES`），不使用无界 response.text/json。
 */
async function readBoundedPreviewBody(
  response: Response,
  requestId: string | undefined,
): Promise<string> {
  try {
    const bytes = await readBoundedResponseBody(
      response,
      CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES,
    );
    return decodeBoundedResponseBodyText(bytes);
  } catch (cause) {
    if (cause instanceof BoundedResponseBodyError) {
      if (cause.kind === "limit_exceeded") {
        throw limitExceededError({
          status: response.status,
          requestId,
          message: "Conversation share response exceeds the readable limit",
        });
      }
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share API returned an invalid content length",
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
        cause,
      });
    }
    throw cause;
  }
}

interface ConversationSharePreviewClientOptions {
  /** 分享 API 的 base（如 https://host/api/v1）。测试必须指向 loopback。 */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  diagnostics?: ConversationSharePreviewDiagnostics;
}

export class ConversationSharePreviewClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly diagnostics: ConversationSharePreviewDiagnostics;

  constructor(options: ConversationSharePreviewClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    // 直接保存 window.fetch 后以实例方法调用会把 this 绑定到 Client，Chromium 因此抛 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.diagnostics = options.diagnostics ?? DEFAULT_DIAGNOSTICS;
  }

  async getPreview(
    shareCode: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConversationSharePreview> {
    if (!isSafeConversationShareCode(shareCode)) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Invalid conversation share code",
      });
    }

    const requestTarget = `${this.baseUrl}/shares/<redacted>/preview`;
    this.diagnostics.info("preview_request_started", {
      requestTarget,
      pageOrigin: globalThis.location?.origin ?? "unavailable",
      shareCodeLength: shareCode.length,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/shares/${encodeURIComponent(shareCode)}/preview`,
        {
          method: "GET",
          // 公开页是匿名读取：即使与 API 同源，也不允许带上访客的会话 cookie。
          credentials: "omit",
          // 不把分享页地址（含 code）当作 Referer 发给预览/下载链路。
          referrerPolicy: "no-referrer",
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = rawErrorMessage
        .replaceAll(shareCode, "<redacted>")
        .replaceAll(encodeURIComponent(shareCode), "<redacted>");
      this.diagnostics.warn("preview_request_failed", {
        requestTarget,
        errorName,
        errorMessage,
      });
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Unable to load this conversation share",
        cause: error,
      });
    }

    this.diagnostics.info("preview_response_received", {
      requestTarget,
      status: response.status,
      ok: response.ok,
      redirected: response.redirected,
      contentType: response.headers.get("content-type"),
    });

    const headerId = conversationShareRequestIdSchema.safeParse(
      response.headers.get("x-request-id"),
    );
    const requestId = headerId.success ? headerId.data : undefined;
    let body: string;
    try {
      body = await readBoundedPreviewBody(response, requestId);
    } catch (cause) {
      // 超限错误必须保留自己的分类，不能被下面的网络错误改写。
      if (cause instanceof ConversationSharePreviewClientError) throw cause;
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Share response interrupted",
        status: response.status,
        requestId,
        cause,
      });
    }
    if (!response.ok && !body.trim()) {
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ConversationSharePreviewClientError({
        kind: response.ok ? "invalid_contract" : classifyConversationShareError(response.status),
        message: "Conversation share API returned invalid JSON",
        status: response.status,
        requestId,
        cause: error,
      });
    }

    if (!response.ok) {
      const parsedError = conversationShareErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        // 未知业务码保留 code 和请求 ID，方便关联服务端日志。
        throw new ConversationSharePreviewClientError({
          kind: classifyConversationShareError(response.status, parsedError.data.code),
          message: parsedError.data.msg,
          status: response.status,
          requestId: requestId ?? parsedError.data.logid,
          code: parsedError.data.code,
        });
      }
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }

    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share preview does not match the public contract",
        status: response.status,
        requestId,
        cause: parsed.error,
      });
    }
    const data = parsed.data.data;
    // 落地页镜像是独立部署、独立回滚的，所以它随时可能比发布分享的客户端旧。版本高于本
    // build 认知时要说「请升级」，不能混进「分享格式无效」。
    if (!isConversationShareSchemaVersionSupported(data.schema_version)) {
      this.diagnostics.warn("preview_schema_version_unsupported", {
        requestTarget,
        version: data.schema_version,
      });
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Conversation share requires a newer ZCode version",
        status: response.status,
        requestId,
      });
    }
    // 逐行降级：认不出的行跳过并计数，不让整页打不开。
    const decoded = decodeConversationShareRows(data.rows);
    if (decoded.unsupportedCount > 0) {
      this.diagnostics.info("preview_dropped_unsupported_rows", {
        requestTarget,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return { ...data, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }
}
