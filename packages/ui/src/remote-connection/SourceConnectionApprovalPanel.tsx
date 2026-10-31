import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import {
  TID_SOURCE_FORCE_CONFIRM,
  TID_SOURCE_INSTALL_CANCEL,
  TID_SOURCE_INSTALL_CONFIRM,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SourceInstallConfirmation } from "@/lib/sourceServerManagement.js";
import type { SourceRunningTasksConfirmation } from "@/lib/sourceServerWizardFlow.js";

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1048576).toFixed(1)} MB`;
}

/**
 * 安装/升级与 running-task force 的确认面板。
 *
 * preview 与 expectedTarget 来自展示时的管理快照；确认后目标变化必须由 Host 拒绝，
 * 本组件不重新解析目标，也不把 force 当成身份/制品校验的旁路。
 */
export function SourceConnectionApprovalPanel({
  installConfirmation,
  runningTasksConfirmation,
  loading,
  onConfirmInstall,
  onCancelInstall,
  onConfirmForce,
  onCancelForce,
}: {
  installConfirmation?: SourceInstallConfirmation | null;
  runningTasksConfirmation?: SourceRunningTasksConfirmation | null;
  loading: boolean;
  onConfirmInstall: () => void;
  onCancelInstall: () => void;
  onConfirmForce: () => void;
  onCancelForce: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (installConfirmation) {
    const { controllerUpgradeRequired, preview, expectedTarget } = installConfirmation;
    return (
      <div
        data-testid="source-install-panel"
        className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
      >
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">
            {intl.formatMessage({
              id: controllerUpgradeRequired
                ? "source.upgradeControllerRequired.title"
                : "source.install.title",
            })}
          </p>
          <p className="text-foreground-subtle">
            {intl.formatMessage({
              id: controllerUpgradeRequired
                ? "source.upgradeControllerRequired.description"
                : "source.install.description",
            })}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui-sm">
            <dt className="text-foreground-subtle">
              {intl.formatMessage({ id: "source.install.target" })}
            </dt>
            <dd className="break-all font-mono">
              {expectedTarget
                ? expectedTarget.kind === "docker"
                  ? `docker:${expectedTarget.container}`
                  : expectedTarget.kind === "wsl"
                    ? `wsl:${expectedTarget.distro}:${expectedTarget.user}`
                    : `${expectedTarget.username}@${expectedTarget.host}:${expectedTarget.port}`
                : intl.formatMessage({ id: "source.install.targetUnresolved" })}
            </dd>
            <dt className="text-foreground-subtle">
              {intl.formatMessage({ id: "source.install.version" })}
            </dt>
            <dd className="font-mono" data-testid="source-install-version">
              {preview?.version ?? intl.formatMessage({ id: "source.infoUnavailable" })}
            </dd>
            <dt className="text-foreground-subtle">
              {intl.formatMessage({ id: "source.install.location" })}
            </dt>
            <dd className="break-all font-mono" data-testid="source-install-path">
              {preview?.installPath ?? intl.formatMessage({ id: "source.infoUnavailable" })}
            </dd>
            <dt className="text-foreground-subtle">
              {intl.formatMessage({ id: "source.install.size" })}
            </dt>
            <dd className="font-mono">
              {preview
                ? formatSize(preview.sizeBytes)
                : intl.formatMessage({ id: "source.infoUnavailable" })}
            </dd>
          </dl>
          {!controllerUpgradeRequired ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                data-testid={TID_SOURCE_INSTALL_CONFIRM}
                disabled={loading || !expectedTarget}
                onClick={onConfirmInstall}
              >
                {loading ? <LoaderIcon className="size-4 animate-spin" /> : null}
                {intl.formatMessage({ id: "source.install.confirm" })}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid={TID_SOURCE_INSTALL_CANCEL}
                disabled={loading}
                onClick={onCancelInstall}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (runningTasksConfirmation) {
    return (
      <div
        data-testid="source-force-panel"
        className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
      >
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">{intl.formatMessage({ id: "source.force.title" })}</p>
          <p className="text-foreground-subtle">
            {intl.formatMessage({ id: "source.force.description" })}
          </p>
          <ul className="space-y-1 text-ui-sm">
            {runningTasksConfirmation.tasks.map((task) => (
              <li key={task.sessionId} className="truncate font-mono">
                {task.workspacePath}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              data-testid={TID_SOURCE_FORCE_CONFIRM}
              disabled={loading}
              onClick={onConfirmForce}
            >
              {loading ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {intl.formatMessage({ id: "source.force.confirm" })}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={onCancelForce}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
