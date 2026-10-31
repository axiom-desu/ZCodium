import { useCallback, useEffect, useRef } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { TID_SSH_ERROR } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";
import { SourceConnectionApprovalPanel } from "@/remote-connection/SourceConnectionApprovalPanel.js";
import type { SourceInstallConfirmation } from "@/lib/sourceServerManagement.js";
import type { SourceRunningTasksConfirmation } from "@/lib/sourceServerWizardFlow.js";

export function RemoteConnectionConnectingStep({
  logs,
  errorMessage,
  loading,
  installConfirmation,
  runningTasksConfirmation,
  onConfirmInstall,
  onCancelInstall,
  onConfirmForce,
  onCancelForce,
  onBack,
  onRetry,
}: {
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  loading: boolean;
  installConfirmation?: SourceInstallConfirmation | null;
  runningTasksConfirmation?: SourceRunningTasksConfirmation | null;
  onConfirmInstall?: () => void;
  onCancelInstall?: () => void;
  onConfirmForce?: () => void;
  onCancelForce?: () => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestLogRef = useRef(true);
  const latestLogId = logs.at(-1)?.id;
  const latestLogTimestamp = logs.at(-1)?.timestamp;

  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
      <div className="flex flex-col flex-1 min-h-0 space-y-4">
        <div className="min-h-0 flex-1 flex flex-col rounded-xl bg-background border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "remote.connectionLog" })}
            </p>
            {loading ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <LoaderIcon className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "remote.connecting" })}
              </div>
            ) : null}
          </div>
          <div
            ref={logContainerRef}
            onScroll={handleLogContainerScroll}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 font-mono text-ui-base"
          >
            {logs.length > 0 ? (
              logs.map((entry) => (
                <div key={entry.id} className="w-full flex min-w-0 leading-5 text-foreground">
                  <span className="text-foreground-subtlest">{entry.timestamp}</span>
                  <span
                    className={cn(
                      "mx-2",
                      entry.level === "success"
                        ? "text-success"
                        : entry.level === "warn"
                          ? "text-warning"
                          : entry.level === "error"
                            ? "text-destructive"
                            : "text-foreground-subtle",
                    )}
                  >
                    [{entry.level.toUpperCase()}]
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))
            ) : (
              <div className="flex min-h-full items-center justify-center text-foreground-subtle">
                <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
              </div>
            )}
          </div>
        </div>

        {installConfirmation || runningTasksConfirmation ? (
          <SourceConnectionApprovalPanel
            installConfirmation={installConfirmation}
            runningTasksConfirmation={runningTasksConfirmation}
            loading={loading}
            onConfirmInstall={() => onConfirmInstall?.()}
            onCancelInstall={() => onCancelInstall?.()}
            onConfirmForce={() => onConfirmForce?.()}
            onCancelForce={() => onCancelForce?.()}
          />
        ) : null}

        {errorMessage ? (
          <div
            data-testid={TID_SSH_ERROR}
            className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/30 px-4 py-3 text-ui-base text-warning"
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">{errorMessage}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void platform.openFeedback();
              }}
              className="h-7 shrink-0 border-warning/30 text-warning hover:bg-warning/10"
            >
              {intl.formatMessage({ id: "remoteConnection.feedback" })}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={loading}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onRetry}
          disabled={loading}
        >
          {loading
            ? intl.formatMessage({ id: "remote.connecting" })
            : intl.formatMessage({ id: "remote.retryConnection" })}
        </Button>
      </div>
    </div>
  );
}
