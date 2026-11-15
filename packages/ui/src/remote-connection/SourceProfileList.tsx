import {
  ArrowDownToLine,
  Ellipsis,
  PowerIcon,
  RotateCw,
  ServerIcon,
  Square,
  Trash2Icon,
  X,
} from "lucide-react";
import { TID_SOURCE_PROFILE_ITEM_PREFIX, TID_SOURCE_PROFILE_LIST } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SourceProfileRow } from "@/lib/sourceServerManagement.js";
import {
  resolveSourceServerDowngradeActionAvailability,
  resolveSourceServerLifecycleActionAvailability,
  resolveSourceServerUpdateCancelAvailability,
} from "@/lib/sourceServerUpdateAction.js";

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
 * 破坏性操作（断开、删除）只由用户显式点击触发；停止/重启/取消更新/显式降级只发管理服务命令，
 * 旧版本（低于生命周期合同）在 UI 禁用，不把缺失方法当作成功。
 */
export function SourceProfileList({
  rows,
  busyProfileId,
  onConnect,
  onDisconnect,
  onRemove,
  onStop,
  onRestart,
  onCancelUpdate,
  onDowngrade,
}: {
  rows: SourceProfileRow[];
  busyProfileId?: string | null;
  onConnect: (row: SourceProfileRow) => void;
  onDisconnect: (row: SourceProfileRow) => void;
  onRemove: (row: SourceProfileRow) => void;
  onStop?: (row: SourceProfileRow) => void;
  onRestart?: (row: SourceProfileRow) => void;
  onCancelUpdate?: (row: SourceProfileRow) => void;
  onDowngrade?: (row: SourceProfileRow) => void;
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
          const lifecycle = resolveSourceServerLifecycleActionAvailability({
            state: row.state,
            deviceBusy: busy,
            ...(row.lastSeenVersion ? { lastSeenVersion: row.lastSeenVersion } : {}),
          });
          const cancel = resolveSourceServerUpdateCancelAvailability({
            state: row.state,
            ...(row.updateCancelable ? { updateCancelable: true } : {}),
            deviceBusy: busy,
          });
          const downgrade = resolveSourceServerDowngradeActionAvailability({
            state: row.state,
            ...(row.updateAvailability ? { updateAvailability: row.updateAvailability } : {}),
            ...(row.upgradeTarget ? { upgradeTarget: row.upgradeTarget } : {}),
            ...(row.currentVersion ? { currentVersion: row.currentVersion } : {}),
            deviceBusy: busy,
          });
          const hasLifecycleMenu =
            Boolean(onStop || onRestart || onCancelUpdate || onDowngrade) &&
            (lifecycle.visible || cancel.visible || downgrade.visible);
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
              {lifecycle.visible && lifecycle.requiresRemoteUpdate ? (
                <span className="shrink-0 text-ui-xs text-warning">
                  {intl.formatMessage({ id: "source.lifecycle.updateRequired" })}
                </span>
              ) : null}
              <span className={cn("shrink-0 text-ui-sm", stateTone(row.state))}>
                {intl.formatMessage({ id: `source.state.${row.state}` })}
              </span>
              {hasLifecycleMenu ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 w-7 shrink-0"
                      aria-label={intl.formatMessage(
                        { id: "source.lifecycle.moreActions" },
                        { source: row.displayName },
                      )}
                      disabled={busy}
                    >
                      <Ellipsis className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {lifecycle.visible && onRestart ? (
                      <DropdownMenuItem
                        data-testid="source-lifecycle-restart"
                        disabled={!lifecycle.enabled}
                        onSelect={() => onRestart(row)}
                      >
                        <RotateCw className="size-4" />
                        {intl.formatMessage({ id: "source.lifecycle.restart" })}
                      </DropdownMenuItem>
                    ) : null}
                    {lifecycle.visible && onStop ? (
                      <DropdownMenuItem
                        data-testid="source-lifecycle-stop"
                        disabled={!lifecycle.enabled}
                        onSelect={() => onStop(row)}
                      >
                        <Square className="size-4" />
                        {intl.formatMessage({ id: "source.lifecycle.stop" })}
                      </DropdownMenuItem>
                    ) : null}
                    {cancel.visible && onCancelUpdate ? (
                      <DropdownMenuItem
                        data-testid="source-lifecycle-cancel-update"
                        disabled={!cancel.enabled}
                        onSelect={() => onCancelUpdate(row)}
                      >
                        <X className="size-4" />
                        {intl.formatMessage({ id: "source.lifecycle.cancelUpdate" })}
                      </DropdownMenuItem>
                    ) : null}
                    {downgrade.visible && onDowngrade ? (
                      <DropdownMenuItem
                        data-testid="source-lifecycle-downgrade"
                        disabled={!downgrade.enabled}
                        onSelect={() => onDowngrade(row)}
                      >
                        <ArrowDownToLine className="size-4" />
                        {intl.formatMessage(
                          { id: "source.lifecycle.downgrade" },
                          { version: row.currentVersion?.replace(/^v/iu, "") ?? "" },
                        )}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    {row.state === "online" && row.sourceServerId ? (
                      <DropdownMenuItem
                        data-testid="source-lifecycle-disconnect"
                        onSelect={() => onDisconnect(row)}
                      >
                        <PowerIcon className="size-4" />
                        {intl.formatMessage({ id: "source.disconnect" })}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      data-testid="source-lifecycle-remove"
                      variant="destructive"
                      onSelect={() => onRemove(row)}
                    >
                      <Trash2Icon className="size-4" />
                      {intl.formatMessage({ id: "source.remove" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
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
