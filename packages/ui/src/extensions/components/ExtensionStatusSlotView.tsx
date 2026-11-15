import { List, Puzzle, Sparkles } from "lucide-react";
import type {
  ExtensionGrant,
  ExtensionSlotIcon,
  ExtensionSlotProjection,
} from "@zcode/shared/extension-host";
import { cn } from "@/components/lib/utils.js";
import { isSlotVisible } from "@/extensions/domain/slotSelectors.js";
import type { ExtensionSlotActions, ExtensionSlotViewState } from "@/extensions/contract.js";

const ICONS = { puzzle: Puzzle, list: List, spark: Sparkles } as const;

export interface ExtensionStatusSlotLabels {
  label: string;
  start: string;
  stop: string;
  enable: string;
  revoke: string;
  pending: string;
  loading: string;
  error: string;
  /** 每个档位的人话说明；用户按它判断读/写会话的授权范围。 */
  grants: Record<ExtensionGrant, string>;
  /** 明确授权语义：第三方 Node 代码以当前用户权限运行，不是 OS 隔离。 */
  notice: string;
}

/** 纯展示组件：真实槽位组件测试直接渲染它，不复制选择/隐藏规则。 */
export function ExtensionStatusSlotView({
  view,
  labels,
  actions,
  className,
}: {
  view: ExtensionSlotViewState;
  labels: ExtensionStatusSlotLabels;
  actions?: Pick<ExtensionSlotActions, "start" | "stop" | "grant" | "revoke">;
  className?: string;
}) {
  if (!view.available) return null;
  if (view.loading) {
    return (
      <div
        className={cn("px-2 text-xs text-muted-foreground", className)}
        data-testid="extension-slot-loading"
      >
        {labels.loading}
      </div>
    );
  }
  const visible = isSlotVisible(view);
  if (!visible && view.pending.length === 0 && !view.canStart && view.phase !== "error") {
    return null;
  }
  return (
    <div
      className={cn("flex flex-col gap-1 px-2 py-1 text-xs", className)}
      data-testid="extension-status-slot"
      data-generation={view.slots[0]?.generation ?? 0}
    >
      <div className="flex items-center gap-1 text-muted-foreground">
        <Puzzle aria-hidden className="h-3 w-3" />
        <span>{labels.label}</span>
        {view.phase === "ready" ? (
          <button type="button" className="ml-auto underline" onClick={() => void actions?.stop()}>
            {labels.stop}
          </button>
        ) : view.canStart ? (
          <button type="button" className="ml-auto underline" onClick={() => void actions?.start()}>
            {labels.start}
          </button>
        ) : null}
      </div>
      {view.phase === "error" ? (
        <div className="text-destructive" role="status">
          {labels.error}
        </div>
      ) : null}
      {view.pending.length > 0 ? (
        <div className="flex flex-col gap-1" role="group" aria-label={labels.pending}>
          <p className="text-muted-foreground" data-testid="extension-consent-notice">
            {labels.notice}
          </p>
          {view.pending.map((plugin) => (
            <div key={plugin.pluginId} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <span className="truncate" title={plugin.name}>
                  {plugin.name}
                </span>
                <button
                  type="button"
                  className="ml-auto underline"
                  onClick={() => void actions?.grant(plugin.pluginId)}
                >
                  {labels.enable}
                </button>
                <button
                  type="button"
                  className="underline"
                  onClick={() => void actions?.revoke(plugin.pluginId)}
                >
                  {labels.revoke}
                </button>
              </div>
              {plugin.declared.length > 0 ? (
                <ul
                  className="text-muted-foreground"
                  data-testid="extension-consent-grants"
                  aria-label={labels.pending}
                >
                  {plugin.declared.map((grant) => (
                    <li key={grant} data-testid={`extension-consent-grant-${grant}`}>
                      {labels.grants[grant]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {visible ? (
        <ul className="flex flex-col gap-0.5">
          {view.slots.map((slot) => (
            <ExtensionSlotItem key={`${slot.pluginId}:${slot.id}`} slot={slot} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ExtensionSlotItem({ slot }: { slot: ExtensionSlotProjection }) {
  const Icon = ICONS[(slot.icon ?? "puzzle") as ExtensionSlotIcon] ?? Puzzle;
  return (
    <li
      className="flex items-center gap-1"
      data-testid={`extension-slot-${slot.pluginId}-${slot.id}`}
    >
      <Icon aria-hidden className="h-3 w-3" />
      <span className="truncate" title={slot.pluginName}>
        {slot.title}
      </span>
    </li>
  );
}
