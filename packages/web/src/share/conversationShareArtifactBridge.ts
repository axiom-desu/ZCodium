import {
  BoundedResponseBodyError,
  CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES,
  ConversationShareArtifactReadError,
  classifyConversationShareArtifactUrl,
  readBoundedResponseBody,
  type ConversationShareArtifactReadResult,
  type ConversationShareArtifactReader,
} from "@zcode/shared";

interface ConversationShareArtifactBridgeOptions {
  fetchImpl?: typeof fetch;
}

/**
 * 公开落地页的 artifact 网络桥。
 *
 * UI 只拿到一个读取端口，不复制网络策略；这里统一保证：
 * - 只接受分类器放行的 http(s)，`data:` 由 UI 本地解码，不进入网络；
 * - GET + credentials:omit + no-referrer：同源图片/文本也不能携带访客 cookie；
 * - 正文走 shared 的有界读取器，预算等于归档合同允许的单件 artifact 大小。
 */
export function createConversationShareArtifactReader(
  options: ConversationShareArtifactBridgeOptions = {},
): ConversationShareArtifactReader {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async read(
      url: string,
      readOptions: { signal?: AbortSignal } = {},
    ): Promise<ConversationShareArtifactReadResult> {
      const source = classifyConversationShareArtifactUrl(url);
      if (!source || source.kind !== "network") {
        throw new ConversationShareArtifactReadError({
          kind: "unsupported_url",
          message: "Artifact URL is not an http(s) resource",
        });
      }

      let response: Response;
      try {
        response = await fetchImpl(source.url, {
          method: "GET",
          // 公开页是匿名读取：即使 artifact 与页面同源，也不允许带上访客的会话 cookie。
          credentials: "omit",
          // 不把分享页地址（含 code）当作 Referer 发给 artifact 下载链路。
          referrerPolicy: "no-referrer",
          ...(readOptions.signal ? { signal: readOptions.signal } : {}),
        });
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "name" in cause &&
          cause.name === "AbortError"
        ) {
          throw cause;
        }
        throw new ConversationShareArtifactReadError({
          kind: "unavailable",
          message: "Artifact request failed",
          cause,
        });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConversationShareArtifactReadError({
          kind: "unavailable",
          message: "Artifact is not available",
          status: response.status,
        });
      }

      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await readBoundedResponseBody(response, CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES);
      } catch (cause) {
        if (cause instanceof BoundedResponseBodyError) {
          if (cause.kind === "limit_exceeded") {
            throw new ConversationShareArtifactReadError({
              kind: "limit_exceeded",
              message: "Artifact exceeds the readable limit",
              status: response.status,
              cause,
            });
          }
          throw new ConversationShareArtifactReadError({
            kind: "invalid_payload",
            message: "Artifact response declares an invalid content length",
            status: response.status,
            cause,
          });
        }
        throw new ConversationShareArtifactReadError({
          kind: "unavailable",
          message: "Artifact response was interrupted",
          status: response.status,
          cause,
        });
      }

      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
      return {
        bytes,
        ...(contentType ? { mediaType: contentType } : {}),
      };
    },
  };
}
