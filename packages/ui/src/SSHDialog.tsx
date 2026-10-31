/* eslint-disable max-lines -- 远程连接向导的状态编排暂集中在同一组件，后续有独立拆分计划。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createUuid,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type SourceServerUpdateTarget,
} from "@zcode/shared";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  classifySourceServerFailure,
  type SourceInstallConfirmation,
  type SourceProfileRow,
} from "@/lib/sourceServerManagement.js";
import { resolveSourceServerErrorPresentation } from "@/lib/sourceServerErrorPresentation.js";
import { loadRemoteTargetCredentials } from "@/lib/remoteWorkspaceHistory.js";
import {
  createRemoteTargetFromProfile,
  listSourceProfiles,
  prepareSourceConnection,
  type SourceRunningTasksConfirmation,
} from "@/lib/sourceServerWizardFlow.js";
import {
  beginRemoteEntryEpoch,
  isRemoteEntryEpochCurrent,
  shouldAutoAdvanceRemoteCompletion,
} from "@/lib/sourceServerManagement.js";
import {
  buildRemoteTarget,
  getRemoteWizardStepCopy,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";

import { SourceProfileList } from "@/remote-connection/SourceProfileList.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionKindStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import {
  RemoteConnectionWizardHeader,
  RemoteConnectionWizardSidebar,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { VariantProps } from "class-variance-authority";

interface RemoteConnectionDialogProps {
  onConnect: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectProject: (sessionId: string, path: string, localWorkspacePath?: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTriggerWhenClosed?: boolean;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
}

export function RemoteConnectionDialog({
  onConnect,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  hideTriggerWhenClosed = false,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  preferredKind,
  preferredWslDistro,
}: RemoteConnectionDialogProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [currentStep, setCurrentStep] = useState<RemoteWizardStep>("kind");
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  // Source 管理只经既有 Host 服务 accessor；server 直连不读这份快照做 profile 编排。
  const {
    management: sourceManagement,
    snapshot: sourceSnapshot,
    applySnapshot: applySourceSnapshot,
  } = useSourceServerManagementSnapshot({
    // 关闭且无待处理目标时不订阅目录事件，避免启动即触发 directory 迁移/读取。
    enabled: open || Boolean(connectedSessionId) || Boolean(pendingRemoteTarget),
  });
  const sourceProfiles = useMemo(() => listSourceProfiles(sourceSnapshot), [sourceSnapshot]);
  const [installConfirmation, setInstallConfirmation] = useState<SourceInstallConfirmation | null>(
    null,
  );
  const [runningTasksConfirmation, setRunningTasksConfirmation] =
    useState<SourceRunningTasksConfirmation | null>(null);
  const [busySourceProfileId, setBusySourceProfileId] = useState<string | null>(null);
  const entryEpochRef = useRef(0);
  const minimizedRef = useRef(false);
  const pendingContinueRef = useRef<{ sessionId: string; epoch: number } | null>(null);

  const clearSourceApprovals = useCallback(() => {
    setInstallConfirmation(null);
    setRunningTasksConfirmation(null);
  }, []);
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive = isRemoteConnectionFlowActive(flowSnapshot);

  useEffect(() => {
    onFlowActiveChange?.(flowActive);
  }, [flowActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  const resetFeedback = () => {
    setError("");
    setValidationMessage("");
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean }) => {
      // 关闭即作废本入口所有 await 归属；迟到的连接/快照结果只能释放自身资源。
      beginRemoteEntryEpoch(entryEpochRef);
      minimizedRef.current = false;
      pendingContinueRef.current = null;
      clearSourceApprovals();
      const sessionId = connectedSessionId;
      if (!options?.preserveSession && sessionId) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep("kind");
      setConnectedSessionId(null);
      setPendingRemoteTarget(null);
      updateConnectingRequestId(null);
      applyOpenState(false);
    },
    [
      cancelPendingRemoteConnection,
      clearSourceApprovals,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const handleCloseRequest = useCallback(async () => {
    const confirmed = await confirmRemoteFlowDiscard();
    if (!confirmed) {
      return;
    }
    closeDialog();
  }, [closeDialog, confirmRemoteFlowDiscard]);

  const startRemoteConnection = async (
    target: RemoteTarget,
    options?: {
      profileId?: string;
      profileDisplayName?: string;
      confirmSourceServerInstall?: boolean;
      expectedTarget?: SourceServerUpdateTarget;
      force?: boolean;
    },
  ) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (loading || busySourceProfileId) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    // 每次新的连接尝试推进入口 epoch；关闭/收起/取消/改目标也会推进，迟到结果必须作废。
    const epoch = beginRemoteEntryEpoch(entryEpochRef);
    const stillCurrent = () => isRemoteEntryEpochCurrent(entryEpochRef, epoch);

    setPendingRemoteTarget(nextTarget);
    setLoading(true);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    clearSourceApprovals();
    resetConnectionLogs();
    setCurrentStep("connecting");

    try {
      if (sourceManagement && nextTarget.kind !== "server") {
        setBusySourceProfileId(options?.profileId ?? null);
        const prepared = await prepareSourceConnection({
          management: sourceManagement,
          target: nextTarget,
          snapshot: sourceSnapshot,
          ...(options?.profileId ? { profileId: options.profileId } : {}),
          ...(options?.profileDisplayName
            ? { profileDisplayName: options.profileDisplayName }
            : {}),
          ...(options?.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
          ...(options?.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
          ...(options?.force ? { force: true } : {}),
        });
        if (!stillCurrent()) return;
        if (prepared.kind === "failed") throw prepared.error;
        if (prepared.kind !== "skipped") applySourceSnapshot(prepared.snapshot);
        if (
          prepared.kind === "install-required" ||
          prepared.kind === "controller-upgrade-required"
        ) {
          setInstallConfirmation(prepared.confirmation);
          setLoading(false);
          setBusySourceProfileId(null);
          return;
        }
        if (prepared.kind === "running-tasks") {
          setRunningTasksConfirmation(prepared.confirmation);
          setLoading(false);
          setBusySourceProfileId(null);
          return;
        }
      }

      const sessionId = await onConnect(nextTarget, requestId);
      if (!stillCurrent()) {
        // 关闭/取消/切目标后迟到成功只释放自己创建的 session，不导航、不写历史。
        void handleCancelSession(sessionId);
        return;
      }
      const completionState = getRemoteConnectionCompletionDialogState("success");
      if (
        !shouldAutoAdvanceRemoteCompletion({
          minimized: minimizedRef.current,
          stillSameEntry: true,
        })
      ) {
        // 后台成功只保留结果；显式点击「继续」才进入目录/历史。
        setConnectedSessionId(sessionId);
        pendingContinueRef.current = { sessionId, epoch };
        toast(intl.formatMessage({ id: "source.backgroundReady" }), {
          variant: "info",
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
          actionLabel: intl.formatMessage({ id: "source.continue" }),
          dedupeKey: `source-background:${requestId}`,
          onAction: () => {
            const pending = pendingContinueRef.current;
            if (!pending || pending.epoch !== epoch) return;
            if (!isRemoteEntryEpochCurrent(entryEpochRef, epoch)) return;
            pendingContinueRef.current = null;
            minimizedRef.current = false;
            setCurrentStep(completionState.step);
            applyOpenState(completionState.open);
          },
        });
        return;
      }
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
    } catch (connectError) {
      if (!stillCurrent()) return;
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const classification = classifySourceServerFailure(connectError);
      const presentation = resolveSourceServerErrorPresentation(classification.code);
      const errorMessage = getErrorMessage(connectError);
      // typed Source 失败补充既有错误分类标题；原始错误仍完整展示，便于排查。
      setError(
        classification.code
          ? `${intl.formatMessage({ id: presentation.titleId })}: ${errorMessage}`
          : errorMessage,
      );
      setCurrentStep(completionState.step);
      if (!minimizedRef.current) applyOpenState(completionState.open);
    } finally {
      if (stillCurrent()) {
        setLoading(false);
        setBusySourceProfileId(null);
      }
    }
  };

  const handleConnect = async () => {
    if (loading) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const { target: nextTarget, errorMessage } = buildRemoteTarget(intl, {
      kind,
      host,
      port,
      username,
      sshAuthMethod,
      password,
      privateKeyPath,
      privateKeyPassphrase,
      selectedSshConfigAlias,
      wslDistro,
      wslUser,
      dockerContainer,
      manualDockerContainer,
      serverUrl,
      serverName,
      serverToken,
      serverWorkspacePath,
    });
    if (!nextTarget) {
      // 必填项缺失属于表单校验，不应该和真实连接失败共用 destructive 错误样式。
      // 这里单独落到 settings 步骤内的 warning 提示，用户能更快理解是“缺少输入”而不是“连接出错”。
      setValidationMessage(errorMessage ?? "Connection failed");
      return;
    }

    resetFeedback();
    setPendingRemoteTarget(nextTarget);
    await startRemoteConnection(nextTarget);
  };

  const handleStartPendingRemoteConnection = useCallback(() => {
    if (!pendingRemoteTarget) {
      void handleConnect();
      return;
    }

    void startRemoteConnection(pendingRemoteTarget);
  }, [handleConnect, pendingRemoteTarget, startRemoteConnection]);

  const handleConfirmInstall = useCallback(() => {
    const confirmation = installConfirmation;
    const target = pendingRemoteTarget;
    if (!confirmation || !target) return;
    // 确认必须带 preview 时冻结的 target；Host 会拒绝 await 期间的目标变更。
    setInstallConfirmation(null);
    void startRemoteConnection(target, {
      profileId: confirmation.profileId,
      confirmSourceServerInstall: true,
      ...(confirmation.expectedTarget ? { expectedTarget: confirmation.expectedTarget } : {}),
    });
  }, [installConfirmation, pendingRemoteTarget, startRemoteConnection]);

  const handleCancelInstall = useCallback(() => {
    setInstallConfirmation(null);
    setCurrentStep("settings");
  }, []);

  const handleConfirmForce = useCallback(() => {
    const confirmation = runningTasksConfirmation;
    const target = pendingRemoteTarget;
    if (!confirmation || !target) return;
    setRunningTasksConfirmation(null);
    void startRemoteConnection(target, {
      profileId: confirmation.profileId,
      force: true,
      confirmSourceServerInstall: true,
      ...(confirmation.expectedTarget ? { expectedTarget: confirmation.expectedTarget } : {}),
    });
  }, [pendingRemoteTarget, runningTasksConfirmation, startRemoteConnection]);

  const handleCancelForce = useCallback(() => {
    setRunningTasksConfirmation(null);
    setCurrentStep("settings");
  }, []);

  const handleConnectSavedProfile = useCallback(
    async (row: SourceProfileRow) => {
      if (!sourceManagement || loading || busySourceProfileId) return;
      const profile = sourceSnapshot?.profiles.find(
        (candidate) => candidate.profileId === row.profileId,
      );
      if (!profile) return;
      const epoch = beginRemoteEntryEpoch(entryEpochRef);
      const stillCurrent = () => isRemoteEntryEpochCurrent(entryEpochRef, epoch);
      setBusySourceProfileId(row.profileId);
      setError("");
      try {
        // 凭据只从 credential port 读回；profile 快照不保存口令。
        const credentials = await loadRemoteTargetCredentials(
          profile.target,
          baseServices.credentialService.load,
        );
        if (!stillCurrent()) return;
        const target = createRemoteTargetFromProfile(profile, credentials);
        await startRemoteConnection(target, { profileId: row.profileId });
      } catch (profileError) {
        if (!stillCurrent()) return;
        setError(getErrorMessage(profileError));
      } finally {
        if (stillCurrent()) setBusySourceProfileId(null);
      }
    },
    [
      baseServices.credentialService,
      busySourceProfileId,
      loading,
      sourceManagement,
      sourceSnapshot,
      startRemoteConnection,
    ],
  );

  const handleDisconnectSavedProfile = useCallback(
    async (row: SourceProfileRow) => {
      if (!sourceManagement || !row.sourceServerId) return;
      setBusySourceProfileId(row.profileId);
      try {
        applySourceSnapshot(await sourceManagement.disconnect(row.sourceServerId));
      } catch (disconnectError) {
        setError(getErrorMessage(disconnectError));
      } finally {
        setBusySourceProfileId(null);
      }
    },
    [applySourceSnapshot, sourceManagement],
  );

  const handleRemoveSavedProfile = useCallback(
    async (row: SourceProfileRow) => {
      if (!sourceManagement) return;
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "source.removeConfirmTitle" }),
        description: intl.formatMessage({ id: "source.removeConfirmDescription" }),
        confirmLabel: intl.formatMessage({ id: "source.remove" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
      if (!confirmed) return;
      setBusySourceProfileId(row.profileId);
      try {
        applySourceSnapshot(
          row.sourceServerId
            ? await sourceManagement.removeSource(row.sourceServerId)
            : await sourceManagement.removeProfile(row.profileId),
        );
      } catch (removeError) {
        setError(getErrorMessage(removeError));
      } finally {
        setBusySourceProfileId(null);
      }
    },
    [applySourceSnapshot, confirmDialog, intl, sourceManagement],
  );

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    const epoch = entryEpochRef.current;
    try {
      await onCancelSession(connectedSessionId);
      if (!isRemoteEntryEpochCurrent(entryEpochRef, epoch)) return;
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      const epoch = entryEpochRef.current;
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        // 选中目录期间关闭/收起/改目标后不得再推进导航或激活 tab。
        if (!isRemoteEntryEpochCurrent(entryEpochRef, epoch)) return;
        resetConnectionLogs();
        setCurrentStep("kind");
        setConnectedSessionId(null);
        setPendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      minimizedRef.current = false;
      const pendingContinue = pendingContinueRef.current;
      if (pendingContinue) {
        // 后台成功后的继续入口：保留已完成 session，直接回到目录步骤。
        pendingContinueRef.current = null;
        setConnectedSessionId(pendingContinue.sessionId);
        setCurrentStep(getRemoteConnectionCompletionDialogState("success").step);
        applyOpenState(true);
        return;
      }
      if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
        resetFeedback();
        resetConnectionLogs();
        setCurrentStep("kind");
        setPendingRemoteTarget(null);
      }
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind);

  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => {
            minimizedRef.current = false;
            const pendingContinue = pendingContinueRef.current;
            if (pendingContinue) {
              pendingContinueRef.current = null;
              setConnectedSessionId(pendingContinue.sessionId);
              setCurrentStep(getRemoteConnectionCompletionDialogState("success").step);
              applyOpenState(true);
              return;
            }
            if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
              resetFeedback();
              resetConnectionLogs();
              setCurrentStep("kind");
              setPendingRemoteTarget(null);
            }
            applyOpenState(true);
          }}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-1rem)] max-h-168 w-[calc(100vw-1rem)] max-w-4xl overflow-hidden rounded-2xl p-0 md:h-[calc(100vh-6rem)]"
        >
          <div
            data-testid={TID_SSH_DIALOG}
            className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row"
          >
            <RemoteConnectionWizardSidebar currentStep={currentStep} />

            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  title={stepCopy.title}
                  description={stepCopy.description}
                  onMinimize={
                    flowActive
                      ? () => {
                          // 连接慢时用户只能关闭弹窗，关闭会取消 pending 连接并丢失当前步骤。
                          // 这里把“收起”明确拆成仅隐藏 dialog，不重置状态、不取消后台连接；
                          // 收起期间成功只保留结果并提示显式继续，不自动推进导航。
                          minimizedRef.current = true;
                          applyOpenState(false);
                        }
                      : undefined
                  }
                  onClose={() => {
                    // 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
                    void handleCloseRequest();
                  }}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // 远程连接的错误提示以前直接拼接颜色 token，和全局状态反馈样式不一致。
                  // 这里统一改成 destructive 语义色对，避免 SSH/Docker 两种模式出现不同的错误视觉。
                  className="flex items-start gap-3 rounded-xl bg-destructive px-4 py-3 text-ui-base text-destructive-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div className="w-full min-h-0 flex-1">
                {currentStep === "kind" ? (
                  <RemoteConnectionKindStep
                    kind={kind}
                    availableKinds={availableKinds}
                    onKindChange={setKind}
                    onCancel={() => closeDialog()}
                    onNext={() => {
                      resetFeedback();
                      setCurrentStep("settings");
                    }}
                  />
                ) : null}

                {currentStep === "settings" && sourceProfiles.length > 0 ? (
                  <SourceProfileList
                    rows={sourceProfiles}
                    busyProfileId={busySourceProfileId}
                    onConnect={(row) => {
                      void handleConnectSavedProfile(row);
                    }}
                    onDisconnect={(row) => {
                      void handleDisconnectSavedProfile(row);
                    }}
                    onRemove={(row) => {
                      void handleRemoveSavedProfile(row);
                    }}
                  />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep
                    kind={kind}
                    host={host}
                    port={port}
                    username={username}
                    sshAuthMethod={sshAuthMethod}
                    password={password}
                    privateKeyPath={privateKeyPath}
                    privateKeyPassphrase={privateKeyPassphrase}
                    wslDistro={wslDistro}
                    wslUser={wslUser}
                    wslDistros={wslDistros}
                    dockerContainer={dockerContainer}
                    manualDockerContainer={manualDockerContainer}
                    dockerContainers={dockerContainers}
                    dockerAvailable={dockerAvailable}
                    serverUrl={serverUrl}
                    serverName={serverName}
                    serverToken={serverToken}
                    serverWorkspacePath={serverWorkspacePath}
                    sshConfigAliases={sshConfigAliases}
                    sshConfigAliasesLoading={sshConfigAliasesLoading}
                    sshConfigAliasesError={sshConfigAliasesError}
                    selectedSshConfigAlias={selectedSshConfigAlias}
                    currentRuntimeOptionsLoading={currentRuntimeOptionsLoading}
                    currentRuntimeOptionsError={currentRuntimeOptionsError}
                    remoteWorkspaceSessions={remoteWorkspaceSessions}
                    validationMessage={validationMessage}
                    loading={loading}
                    onBack={() => {
                      resetFeedback();
                      setCurrentStep("kind");
                    }}
                    onHostChange={setHost}
                    onPortChange={setPort}
                    onUsernameChange={setUsername}
                    onSshAuthMethodChange={setSshAuthMethod}
                    onPasswordChange={setPassword}
                    onPrivateKeyPathChange={setPrivateKeyPath}
                    onPrivateKeyPassphraseChange={setPrivateKeyPassphrase}
                    onWslDistroChange={setWslDistro}
                    onWslUserChange={setWslUser}
                    onDockerContainerChange={setDockerContainer}
                    onManualDockerContainerChange={setManualDockerContainer}
                    onServerUrlChange={setServerUrl}
                    onServerNameChange={setServerName}
                    onServerTokenChange={setServerToken}
                    onServerWorkspacePathChange={setServerWorkspacePath}
                    onDockerContainersRefresh={refreshDockerContainers}
                    onApplySshConfigAlias={applySshConfigAlias}
                    onClearSelectedSshConfigAlias={clearSelectedSshConfigAlias}
                    onConnect={() => {
                      void handleConnect();
                    }}
                  />
                ) : null}

                {currentStep === "connecting" ? (
                  <RemoteConnectionConnectingStep
                    logs={connectionLogs}
                    errorMessage={error}
                    loading={loading}
                    installConfirmation={installConfirmation}
                    runningTasksConfirmation={runningTasksConfirmation}
                    onConfirmInstall={handleConfirmInstall}
                    onCancelInstall={handleCancelInstall}
                    onConfirmForce={handleConfirmForce}
                    onCancelForce={handleCancelForce}
                    onBack={() => {
                      void (async () => {
                        const confirmed = await confirmRemoteFlowDiscard();
                        if (!confirmed) {
                          return;
                        }

                        if (loading) {
                          await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
                          setLoading(false);
                        }
                        resetFeedback();
                        updateConnectingRequestId(null);
                        setCurrentStep("settings");
                      })();
                    }}
                    onRetry={() => {
                      handleStartPendingRemoteConnection();
                    }}
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="h-full">
                    <RemoteConnectionDirectoryStep
                      services={directoryBrowserServices}
                      remoteTarget={pendingRemoteTarget}
                      localSkillSyncService={baseServices.skillSyncService}
                      remoteSkillSyncService={directoryBrowserServices?.skillSyncService ?? null}
                      localMcpSyncService={baseServices.mcpSyncService}
                      remoteMcpSyncService={directoryBrowserServices?.mcpSyncService ?? null}
                      localPluginSyncService={baseServices.pluginSyncService}
                      remotePluginSyncService={directoryBrowserServices?.pluginSyncService ?? null}
                      localZCodeAgentService={baseServices.zcodeAgentService}
                      remoteZCodeAgentService={directoryBrowserServices?.zcodeAgentService ?? null}
                      localWorkspacePath={localWorkspacePath}
                      selecting={selectingDirectory}
                      onSelect={(path) => {
                        void handleSelectDirectory(path);
                      }}
                      onBack={() => {
                        void (async () => {
                          const confirmed = await confirmRemoteFlowDiscard();
                          if (!confirmed) {
                            return;
                          }

                          await handleBackToConnection();
                        })();
                      }}
                      onCancel={() => {
                        void handleCloseRequest();
                      }}
                      onSkillsSynced={async () => undefined}
                      onMcpSynced={async () => undefined}
                      onPluginsSynced={async () => undefined}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;
