import { Component, useMemo, useState, type ReactNode } from "react";
import {
  type ConversationShareArtifactReader,
  type ConversationShareToolContentBlock,
  type ConversationShareWorkflowContentBlock,
  type Locale,
  type ShareToolPresentationPayload,
} from "@zcode/shared";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { WorkflowCompletionCard } from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import {
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SharedArtifact, SharedToolImage } from "@/v4/ConversationShareArtifactContent.js";

/**
 * 分享内容块渲染器。
 *
 * 边界与只读时间线相同：公开页没有宿主能力（workspace、session、platform、tab store），
 * 因此这里只画公开 schema 里的事实，绝不复用需要宿主上下文的工具渲染器。
 * 认不出的块由时间线保留原位摘要（fallback row），这里只接经过 schema 校验的类型。
 */

class ContentBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function WorkflowContent({
  block,
  artifactUrls,
  artifactReader,
  locale,
  onOpenResource,
}: {
  block: ConversationShareWorkflowContentBlock;
  artifactUrls: ReadonlyMap<string, string>;
  artifactReader?: ConversationShareArtifactReader;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  const { payload } = block;
  const [selected, setSelected] = useState<string>();
  const [runOpen, setRunOpen] = useState(false);
  const run = useMemo(
    () => (payload.run ? { ...payload.run, runId: block.id } : undefined),
    [payload.run, block.id],
  );
  const model = useMemo(
    () => (payload.graph && run ? buildWorkflowTimeline(payload.graph, run) : undefined),
    [payload.graph, run],
  );
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const detail = workflowCardDetail(format, model, payload.graph, run);
  const selectedArtifact = payload.artifacts.find((artifact) => artifact.id === selected);
  const figures = {
    ...(payload.duration_ms === undefined ? {} : { durationMs: payload.duration_ms }),
    ...(run
      ? { tokens: run.usage.spentTokens, subagents: run.actors.length, phases: run.phases?.length }
      : {}),
  };
  return (
    <div className="min-w-0" data-share-content-block={block.id}>
      {payload.completion ? (
        <WorkflowCompletionCard
          name={payload.name}
          figures={figures}
          artifacts={payload.artifacts.map((artifact) => ({
            ...artifact,
            ...(artifact.kind === "file" || artifact.kind === "markdown"
              ? { contentType: artifact.content_type }
              : { itemCount: artifact.items?.length ?? 0 }),
          }))}
          onOpenArtifact={setSelected}
          onOpenRun={model ? () => setRunOpen(true) : undefined}
          testIdKey={block.id}
        />
      ) : (
        <section
          className="wf-motion flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5"
          data-share-workflow-run
        >
          <WorkflowCardHeader
            name={payload.name}
            kind={
              run
                ? format({ id: workflowRunKindMessageId(run) })
                : intl.formatMessage({ id: "conversationShare.workflowUnavailable" })
            }
            detail={detail?.detail}
            expanded
            live={false}
            onOpenDetails={model ? () => setRunOpen(true) : undefined}
          />
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={setSelected}
            className="pb-0.5 pt-0.5"
          />
        </section>
      )}
      {payload.unavailable ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "conversationShare.workflowPartial" })}
        </p>
      ) : null}
      <p
        className="mt-1 text-ui-xs text-foreground-subtlest"
        title={new Date(block.captured_at).toLocaleString(locale)}
      >
        {intl.formatMessage({ id: "conversationShare.capturedSnapshot" })}
      </p>
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{payload.name}</DialogTitle>
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={(id) => {
              setRunOpen(false);
              setSelected(id);
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={selectedArtifact !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{selectedArtifact?.title}</DialogTitle>
          {selectedArtifact ? (
            <SharedArtifact
              artifact={selectedArtifact}
              url={
                "resource_id" in selectedArtifact && selectedArtifact.resource_id
                  ? artifactUrls.get(selectedArtifact.resource_id)
                  : undefined
              }
              reader={artifactReader}
              onOpenResource={onOpenResource}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 公开 display 白名单里的字段：只按 kind 逐项读取，不做对象展开。 */
function toolDisplaySummary(display: ShareToolPresentationPayload["display"]): {
  kind: string;
  detail?: string;
  lines?: string[];
} | null {
  if (!display) return null;
  switch (display.kind) {
    case "bash_output":
      return { kind: "terminal", detail: display.output };
    case "file_diff":
      return {
        kind: "diff",
        detail: `${display.filePath} +${display.additions} -${display.deletions}`,
      };
    case "local_agent_message":
      return { kind: "agent", detail: display.message ?? display.error ?? display.status };
    case "task_stop":
      return { kind: "task", detail: display.message };
    case "task_output":
      return { kind: "task", detail: display.output ?? display.taskStatus };
    case "respond_to_coordinator":
      return { kind: "agent", detail: display.status };
    case "mcp_tool":
      return { kind: "mcp", detail: `${display.serverName} · ${display.toolName}` };
    case "cua":
      return { kind: "computer", detail: display.text ?? display.toolName };
    default:
      return null;
  }
}

function ToolPresentationContent({
  block,
  artifactUrls,
  artifactReader,
  onOpenResource,
}: {
  block: ConversationShareToolContentBlock;
  artifactUrls: ReadonlyMap<string, string>;
  artifactReader?: ConversationShareArtifactReader;
  onOpenResource?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const summary = toolDisplaySummary(block.payload.display);
  const images = block.payload.images ?? [];
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-3 pt-2.5"
      data-share-tool-presentation={block.id}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({
            id: summary
              ? `conversationShare.tool.kind.${summary.kind}`
              : "conversationShare.tool.kind.unknown",
          })}
        </span>
        {block.payload.app_name ? (
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
            {block.payload.app_name}
          </span>
        ) : null}
        {block.payload.agent_type ? (
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
            {block.payload.agent_type}
          </span>
        ) : null}
      </div>
      {summary?.detail ? (
        <pre className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle">
          {summary.detail}
        </pre>
      ) : null}
      {images.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          {images.map((image) => (
            <SharedToolImage
              key={image.resource_id}
              resourceId={image.resource_id}
              url={artifactUrls.get(image.resource_id)}
              reader={artifactReader}
              onOpenResource={onOpenResource}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ConversationShareContent({
  blocks,
  fallbacks,
  ...props
}: {
  blocks: readonly (ConversationShareWorkflowContentBlock | ConversationShareToolContentBlock)[];
  fallbacks: ReadonlyMap<number, string>;
  artifactUrls: ReadonlyMap<string, string>;
  artifactReader?: ConversationShareArtifactReader;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocks.map((block) => {
        const fallback = (
          <div className="whitespace-pre-wrap">{fallbacks.get(block.fallback_row_id)}</div>
        );
        return (
          <ContentBoundary key={block.id} fallback={fallback}>
            {block.type === "workflow" ? (
              <WorkflowContent block={block} {...props} />
            ) : (
              <ToolPresentationContent block={block} {...props} />
            )}
          </ContentBoundary>
        );
      })}
    </div>
  );
}
