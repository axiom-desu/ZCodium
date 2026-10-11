import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import type { WebRemoteControlStatusState } from "@zcode/shared";

function triggerStatusLabelId(
  status: WebRemoteControlStatusState,
): "webRemoteControl.trigger" | `webRemoteControl.triggerStatus.${string}` {
  switch (status) {
    case "starting":
      return "webRemoteControl.triggerStatus.starting";
    case "running":
      return "webRemoteControl.triggerStatus.waiting";
    case "connecting":
      return "webRemoteControl.triggerStatus.connecting";
    case "active":
      return "webRemoteControl.triggerStatus.connected";
    case "error":
      return "webRemoteControl.triggerStatus.error";
    default:
      return "webRemoteControl.trigger";
  }
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const [status, setStatus] = useState<WebRemoteControlStatusState>("idle");

  useEffect(() => {
    let cancelled = false;
    void platform
      .getWebRemoteControlStatus()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot.status);
      })
      .catch(() => undefined);
    const dispose = platform.onWebRemoteControlStatusChanged?.((snapshot) => {
      if (!cancelled) setStatus(snapshot.status);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);

  const labelId = triggerStatusLabelId(status);
  const active = status !== "idle";

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            active && !compact ? "text-primary" : undefined,
            className,
          )}
        >
          {/* 入口统一使用远程控制图标，具体 Bot 渠道在弹层内区分。 */}
          <Smartphone className="size-4 text-foreground-subtle" />
          {compact ? (
            <span className="sr-only">{intl.formatMessage({ id: labelId })}</span>
          ) : (
            intl.formatMessage({ id: labelId })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId}
      />
    </>
  );
}
