import { useCallback, useEffect, useMemo, useState } from "react";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import type { Locale } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import {
  ConversationSharePreviewClient,
  ConversationSharePreviewClientError,
  type ConversationSharePreviewErrorKind,
} from "./conversationSharePreviewClient.js";
import { createConversationShareArtifactReader } from "./conversationShareArtifactBridge.js";

/**
 * 匿名公开分享页。
 *
 * 安全边界（与只读时间线同一份约束）：
 * - 只渲染公开契约里的 rows/内容块，未知行逐条跳过并出软提示；
 * - 不注入脚本、不拼 innerHTML；Markdown 走共享渲染器；
 * - 外部资源只来自 https 下载地址（由契约校验），不读宿主文件、不接触本地 workspace。
 */

type LandingCopy = Readonly<Record<string, string>>;

const COPY: Readonly<Record<Locale, LandingCopy>> = {
  "en-US": {
    "conversationShare.landing.loading": "Loading shared conversation…",
    "conversationShare.landing.error": "This share could not be loaded",
    "conversationShare.landing.retry": "Try again",
    "conversationShare.landing.retryHint":
      "Close this page and open the original share link again.",
    "conversationShare.landing.invalidCode": "This share link is incomplete or malformed.",
    "conversationShare.landing.notFound": "This share does not exist or is no longer available.",
    "conversationShare.landing.expired": "This share has expired.",
    "conversationShare.landing.upgrade":
      "This share was created by a newer version of ZCode. Update ZCode and open the link again.",
    "conversationShare.landing.tooLarge": "This share is larger than this page can display.",
    "conversationShare.landing.network":
      "The network request failed. Check your connection and try again.",
    "conversationShare.landing.rateLimited": "Too many requests. Wait a moment and try again.",
    "conversationShare.landing.unavailable": "The share service is temporarily unavailable.",
    "conversationShare.landing.authRequired": "This share requires signing in to view.",
    "conversationShare.landing.accessMode.public_readonly": "Public · read only",
    "conversationShare.landing.accessMode.public_importable": "Public · importable",
    "conversationShare.landing.accessMode.private": "Private link",
    "conversationShare.landing.expires": "Expires",
    "conversationShare.landing.brand": "Shared with ZCode",
  },
  "zh-CN": {
    "conversationShare.landing.loading": "正在加载分享内容…",
    "conversationShare.landing.error": "无法加载该分享",
    "conversationShare.landing.retry": "重试",
    "conversationShare.landing.retryHint": "请关闭本页并重新打开原分享链接。",
    "conversationShare.landing.invalidCode": "分享链接不完整或格式不正确。",
    "conversationShare.landing.notFound": "该分享不存在或已失效。",
    "conversationShare.landing.expired": "该分享已过期。",
    "conversationShare.landing.upgrade": "该分享由更新版本的 ZCode 创建，请升级后重新打开。",
    "conversationShare.landing.tooLarge": "该分享内容超出本页可读取的范围。",
    "conversationShare.landing.network": "网络请求失败，请检查网络后重试。",
    "conversationShare.landing.rateLimited": "请求过于频繁，请稍后重试。",
    "conversationShare.landing.unavailable": "分享服务暂时不可用。",
    "conversationShare.landing.authRequired": "该分享需要登录后查看。",
    "conversationShare.landing.accessMode.public_readonly": "公开 · 只读",
    "conversationShare.landing.accessMode.public_importable": "公开 · 可导入",
    "conversationShare.landing.accessMode.private": "私有链接",
    "conversationShare.landing.expires": "有效期至",
    "conversationShare.landing.brand": "由 ZCode 分享",
  },
};

const ERROR_MESSAGE_ID_BY_KIND: Readonly<Record<string, string>> = {
  invalid_contract: "conversationShare.landing.invalidCode",
  not_found: "conversationShare.landing.notFound",
  expired: "conversationShare.landing.expired",
  import_not_allowed: "conversationShare.landing.notFound",
  unsupported_schema_version: "conversationShare.landing.upgrade",
  limit_exceeded: "conversationShare.landing.tooLarge",
  network: "conversationShare.landing.network",
  rate_limited: "conversationShare.landing.rateLimited",
  service_unavailable: "conversationShare.landing.unavailable",
  authentication_required: "conversationShare.landing.authRequired",
};

const EMPTY_ARTIFACT_URLS: ReadonlyMap<string, string> = new Map();

interface LandingState {
  status: "loading" | "ready" | "error";
  errorKind?: ConversationSharePreviewErrorKind;
  rows?: readonly ConversationRow[];
  unsupportedRowCount?: number;
  contentBlocks?: readonly unknown[];
  title?: string;
  accessMode?: string;
  expiresAt?: number;
  artifactUrls?: ReadonlyMap<string, string>;
}

function ConversationShareLandingPage({
  shareCode,
  locale,
  baseUrl,
  fetchImpl,
}: {
  shareCode: string;
  locale: Locale;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}) {
  const copy = COPY[locale];
  const [state, setState] = useState<LandingState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  // 每个分享范围/重试一代一个新的匿名 reader；旧代次的迟到 artifact 结果不会进入当前卡片。
  const artifactReader = useMemo(
    () => createConversationShareArtifactReader(fetchImpl ? { fetchImpl } : {}),
    [baseUrl, fetchImpl, retryToken, shareCode],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading" });
    const client = new ConversationSharePreviewClient({
      baseUrl,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    void client.getPreview(shareCode, { signal: controller.signal }).then(
      (preview) => {
        if (!active) return;
        const artifactUrls = new Map(
          preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.url] as const),
        );
        setState({
          status: "ready",
          rows: preview.rows,
          unsupportedRowCount: preview.unsupportedRowCount,
          ...(preview.content_blocks ? { contentBlocks: preview.content_blocks } : {}),
          title: preview.share.title,
          accessMode: preview.share.access_mode,
          expiresAt: preview.share.expires_at,
          artifactUrls,
        });
        document.title = preview.share.title;
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ConversationSharePreviewClientError) {
          setState({ status: "error", errorKind: error.kind });
          return;
        }
        setState({ status: "error", errorKind: "unknown" });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [baseUrl, fetchImpl, retryToken, shareCode]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);
  const errorMessageId = state.errorKind ? ERROR_MESSAGE_ID_BY_KIND[state.errorKind] : undefined;
  const expiresLabel = useMemo(() => {
    if (state.expiresAt === undefined || state.expiresAt <= 0) return null;
    const date = new Date(state.expiresAt);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
  }, [locale, state.expiresAt]);

  return (
    <div
      className="h-dvh min-h-dvh w-screen overflow-y-auto bg-background text-foreground"
      data-conversation-share-landing="true"
    >
      <header className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 pb-3 pt-6">
        <span className="text-ui-xs text-foreground-subtlest">
          {copy["conversationShare.landing.brand"]}
        </span>
        {state.status === "ready" ? (
          <>
            <h1
              className="min-w-0 break-words text-ui-xl font-medium"
              data-conversation-share-title
            >
              {state.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
              {state.accessMode ? (
                <span
                  className="rounded-sm border border-border/60 px-1.5 py-0.5"
                  data-conversation-share-access-mode={state.accessMode}
                >
                  {copy[`conversationShare.landing.accessMode.${state.accessMode}`] ??
                    state.accessMode}
                </span>
              ) : null}
              {expiresLabel ? (
                <span>
                  {copy["conversationShare.landing.expires"]} · {expiresLabel}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-4xl pb-10">
        {state.status === "loading" ? (
          <div
            role="status"
            aria-live="polite"
            className="mx-4 rounded-xl border border-border/60 bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
          >
            {copy["conversationShare.landing.loading"]}
          </div>
        ) : state.status === "error" ? (
          <section
            role="alert"
            className="mx-4 flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-4 py-3"
            data-conversation-share-error={state.errorKind ?? "unknown"}
          >
            <h2 className="text-ui-base font-medium">{copy["conversationShare.landing.error"]}</h2>
            <p className="text-ui-sm text-foreground-subtle">
              {copy[errorMessageId ?? ""] ?? copy["conversationShare.landing.error"]}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={retry}
                className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                {copy["conversationShare.landing.retry"]}
              </button>
              <span className="text-ui-xs text-foreground-subtlest">
                {copy["conversationShare.landing.retryHint"]}
              </span>
            </div>
          </section>
        ) : (
          <ConversationShareReadonlyTimeline
            // 重试/换分享时整棵时间线重挂，旧卡片持有的 object URL 随卸载撤销。
            key={`${shareCode}:${retryToken}`}
            rows={state.rows ?? []}
            {...(state.contentBlocks ? { contentBlocks: state.contentBlocks } : {})}
            unsupportedRowCount={state.unsupportedRowCount ?? 0}
            artifactUrls={state.artifactUrls ?? EMPTY_ARTIFACT_URLS}
            artifactReader={artifactReader}
            locale={locale}
          />
        )}
      </main>
    </div>
  );
}

/** 加载态外壳：在 React 入口判定 share 路由后立即渲染，避免先闪工作台。 */
export function ConversationShareLandingLoader({
  shareCode,
  locale,
  baseUrl,
  fetchImpl,
}: {
  shareCode: string | null;
  locale: Locale;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}) {
  if (!shareCode) {
    return (
      <section
        role="alert"
        className="mx-auto mt-16 w-full max-w-lg rounded-xl border border-border/60 bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
        data-conversation-share-error="invalid_contract"
      >
        {COPY[locale]["conversationShare.landing.invalidCode"]}
      </section>
    );
  }
  return (
    <ConversationShareLandingPage
      shareCode={shareCode}
      locale={locale}
      baseUrl={baseUrl}
      {...(fetchImpl ? { fetchImpl } : {})}
    />
  );
}
