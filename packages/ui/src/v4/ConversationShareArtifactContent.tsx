import { useEffect, useState } from "react";
import {
  type ConversationShareArtifactReadErrorKind,
  type ConversationShareArtifactReader,
  type ShareWorkflowArtifact,
  classifyConversationShareArtifactUrl,
} from "@zcode/shared";

import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConversationShareArtifactBytes } from "@/v4/useConversationShareArtifactBytes.js";

function artifactReadFailureMessageId(kind: ConversationShareArtifactReadErrorKind | null): string {
  return kind === "limit_exceeded"
    ? "conversationShare.artifact.limitExceeded"
    : "conversationShare.artifact.previewFailed";
}

/**
 * 单件公开 artifact 的文本/图片呈现。
 *
 * 所有网络读取都经注入的匿名 reader；这里只决定“显示文本还是图片”和“失败时显示哪条本地化提示”，
 * 不复制 GET/credentials/限额策略。读取失败只影响当前卡片，不会清空同一时间线里的其他卡片。
 */
export function SharedArtifact({
  artifact,
  url,
  reader,
  onOpenResource,
}: {
  artifact: ShareWorkflowArtifact;
  url?: string;
  reader?: ConversationShareArtifactReader;
  onOpenResource?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const previewText = "preview_text" in artifact ? artifact.preview_text : undefined;
  // 直接消费本组件的调用方也不能把 javascript:/file: 塞进下载链接。
  const safeUrl =
    url !== undefined && classifyConversationShareArtifactUrl(url) !== null ? url : undefined;
  const [text, setText] = useState<string | undefined>(previewText);
  const [textDecodeFailed, setTextDecodeFailed] = useState(false);
  const contentType = "content_type" in artifact ? artifact.content_type : undefined;
  const readable = artifact.kind === "markdown" || Boolean(contentType?.startsWith("text/"));
  // 只有没有内嵌 preview_text 且确实可读的 artifact 才走网络；读取统一交给匿名 reader。
  const artifactBytes = useConversationShareArtifactBytes({
    url,
    reader,
    enabled:
      !artifact.unavailable && readable && previewText === undefined && safeUrl !== undefined,
    createObjectUrl: false,
  });
  useEffect(() => {
    setText(previewText);
    setTextDecodeFailed(false);
    if (previewText !== undefined || artifactBytes.status !== "ready" || !artifactBytes.blob) {
      return;
    }
    let active = true;
    // Blob 已经受 artifact 预算约束，这里的 text() 不再是无界 response.text()。
    void artifactBytes.blob.text().then(
      (value) => {
        if (active) setText(value);
      },
      () => {
        if (active) setTextDecodeFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [artifactBytes.blob, artifactBytes.status, previewText]);
  if (artifact.unavailable)
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "conversationShare.artifact.notIncluded" })} ·{" "}
        {intl.formatMessage({
          id: {
            source_unavailable: "conversationShare.artifact.sourceUnavailable",
            unsupported: "conversationShare.artifact.unsupported",
            limit_exceeded: "conversationShare.artifact.limitExceeded",
          }[artifact.unavailable],
        })}
      </p>
    );
  if (artifact.kind !== "file" && artifact.kind !== "markdown")
    return (
      <ArtifactPresetBody
        artifact={artifact}
        items={artifact.items ?? []}
        labels={buildPresetLabels(intl.formatMessage.bind(intl))}
        missingLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardUnavailable" })}
        invalidLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardInvalid" })}
      />
    );
  const resourceId = artifact.resource_id;
  const readErrorKind = artifactBytes.status === "error" ? artifactBytes.errorKind : null;
  const failed = textDecodeFailed || readErrorKind !== null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          {intl.formatMessage({ id: "conversationShare.artifact.openDownload" })}
        </a>
      ) : resourceId && onOpenResource ? (
        <button
          type="button"
          onClick={() => onOpenResource(resourceId)}
          className="self-start text-primary underline"
        >
          {intl.formatMessage({ id: "conversationShare.artifact.openFile" })}
        </button>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "conversationShare.artifact.resourceUnavailable" })}
        </p>
      )}
      {failed ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: artifactReadFailureMessageId(readErrorKind) })}
        </p>
      ) : readable && (safeUrl || previewText !== undefined) ? (
        text === undefined ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "conversationShare.artifact.loading" })}
          </p>
        ) : (
          <MessageResponse renderZCodeFileCitations={false}>{text}</MessageResponse>
        )
      ) : contentType?.startsWith("image/") && safeUrl ? (
        <SharedArtifactImage artifact={artifact} url={safeUrl} reader={reader} />
      ) : null}
    </div>
  );
}

function SharedArtifactImage({
  artifact,
  url,
  reader,
}: {
  artifact: ShareWorkflowArtifact;
  url: string;
  reader?: ConversationShareArtifactReader;
}) {
  const { intl } = useZCodeIntl();
  // 图片同样匿名读取成 Blob/object URL：直接 <img src> 在同源部署会带上访客 cookie。
  const { status, objectUrl, errorKind } = useConversationShareArtifactBytes({
    url,
    reader,
    enabled: true,
    createObjectUrl: true,
  });
  if (status === "error") {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: artifactReadFailureMessageId(errorKind) })}
      </p>
    );
  }
  if (!objectUrl) {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "conversationShare.artifact.loading" })}
      </p>
    );
  }
  return <img src={objectUrl} alt={artifact.title} className="max-w-full" />;
}

/** 工具展示里的公开截图：没有 URL 时保持按钮/静态说明，有 URL 时走同一套匿名 Blob 读取。 */
export function SharedToolImage({
  resourceId,
  url,
  reader,
  onOpenResource,
}: {
  resourceId: string;
  url: string | undefined;
  reader?: ConversationShareArtifactReader;
  onOpenResource?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { status, objectUrl, errorKind } = useConversationShareArtifactBytes({
    url,
    reader,
    enabled: url !== undefined,
    createObjectUrl: true,
  });
  if (!url) {
    return onOpenResource ? (
      <button
        type="button"
        onClick={() => onOpenResource(resourceId)}
        className="rounded-lg border border-border px-2 py-1 text-ui-xs text-foreground-subtle hover:bg-hover"
      >
        {intl.formatMessage({ id: "conversationShare.tool.imageUnavailable" })}
      </button>
    ) : (
      // 本地导入副本没有公开下载地址；给出静态说明，不画一个点了没反应的按钮。
      <span className="rounded-lg border border-border px-2 py-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "conversationShare.tool.imageUnavailable" })}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-lg border border-border px-2 py-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({
          id:
            errorKind === "limit_exceeded"
              ? "conversationShare.artifact.limitExceeded"
              : "conversationShare.tool.imageUnavailable",
        })}
      </span>
    );
  }
  if (!objectUrl) {
    return (
      <span className="rounded-lg border border-border px-2 py-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "conversationShare.artifact.loading" })}
      </span>
    );
  }
  return (
    <a
      href={objectUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-full overflow-hidden rounded-lg border border-border bg-surface hover:border-border-hover"
    >
      <img
        src={objectUrl}
        alt={intl.formatMessage({ id: "conversationShare.tool.imageAlt" })}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="max-h-72 max-w-full object-contain"
      />
    </a>
  );
}
