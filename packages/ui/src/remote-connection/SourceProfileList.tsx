import { PowerIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { TID_SOURCE_PROFILE_ITEM_PREFIX, TID_SOURCE_PROFILE_LIST } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SourceProfileRow } from "@/lib/sourceServerManagement.js";

function stateTone(state: SourceProfileRow["state"]): string {
  switch (state) {
    case "online":
      return "text-success";
    case "needs-install":
    case "needs-upgrade":
    case "identity-change-pending":
      return "text-warning";
    case "failed":
      return "text-destructive";
    default:
      return "text-foreground-subtle";
  }
}

/**
 * 已保存 Source 设备的只读列表：显示名/目标/连接状态来自管理快照投影。
 * 破坏性操作（断开、删除）只由用户显式点击触发，列表本身不做自动清理。
 */
export function SourceProfileList({
  rows,
  busyProfileId,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  rows: SourceProfileRow[];
  busyProfileId?: string | null;
  onConnect: (row: SourceProfileRow) => void;
  onDisconnect: (row: SourceProfileRow) => void;
  onRemove: (row: SourceProfileRow) => void;
}) {
  const { intl } = useZCodeIntl();
  if (rows.length === 0) return null;

  return (
    <div
      data-testid={TID_SOURCE_PROFILE_LIST}
      className="flex max-h-44 shrink-0 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-background-alt p-3"
    >
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <ServerIcon className="size-4 shrink-0 text-foreground-subtle" />
        {intl.formatMessage({ id: "source.savedDevices" })}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const busy = busyProfileId === row.profileId;
          return (
            <li
              key={row.profileId}
              data-testid={`${TID_SOURCE_PROFILE_ITEM_PREFIX}${row.profileId}`}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
                <p className="truncate font-mono text-ui-sm text-foreground-subtle">
                  {row.targetLabel}
                </p>
              </div>
              <span className={cn("shrink-0 text-ui-sm", stateTone(row.state))}>
                {intl.formatMessage({ id: `source.state.${row.state}` })}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 shrink-0 px-2"
                disabled={busy}
                onClick={() => onConnect(row)}
              >
                {intl.formatMessage({
                  id: row.state === "online" ? "source.reconnect" : "source.connect",
                })}
              </Button>
              {row.state === "online" && row.sourceServerId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2"
                  aria-label={intl.formatMessage({ id: "source.disconnect" })}
                  disabled={busy}
                  onClick={() => onDisconnect(row)}
                >
                  <PowerIcon className="size-3.5" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-destructive"
                aria-label={intl.formatMessage({ id: "source.remove" })}
                disabled={busy}
                onClick={() => onRemove(row)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
