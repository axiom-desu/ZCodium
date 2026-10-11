import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isReusableWebRemoteControlSession,
  isSameWebRemoteControlTarget,
} from "@/lib/webRemoteControlTarget.js";
import { usePlatform } from "./usePlatform.js";
import type {
  WebRemoteControlStatusSnapshot,
  WebRemoteControlStatusState,
  WebRemoteControlTaskSync,
  WebRemoteControlWorkspaceSync,
} from "@zcode/shared";

/**
 * 手机远控弹层状态机：开层即同步状态（idle/error 自动开启），状态推送 + 1s 轮询双通道，
 * 二维码用 qrcode 生成 data URL。所有平台动作走 IPlatformService，不直接摸 window.zcode。
 */

export interface UseWebRemoteControlResult {
  status: WebRemoteControlStatusState;
  snapshot: WebRemoteControlStatusSnapshot | null;
  busy: boolean;
  qrDataUrl: string | null;
  qrUrl: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshPairing(): Promise<void>;
  copyLink(): Promise<void>;
}

export function useWebRemoteControl(params: {
  open: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 开层期间周期性同步窗口内工作区/任务清单（弹层用 task service 提供）。 */
  loadSyncPayload?: () => Promise<{
    workspaces: WebRemoteControlWorkspaceSync["workspaces"];
    tasks: WebRemoteControlTaskSync["tasks"];
  } | null>;
}): UseWebRemoteControlResult {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<WebRemoteControlStatusSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const qrUrl = snapshot?.qrUrl ?? null;
  const openedRef = useRef(false);

  useEffect(() => {
    if (!params.open) {
      openedRef.current = false;
      return;
    }
    let cancelled = false;
    openedRef.current = true;
    const disposeStatus = platform.onWebRemoteControlStatusChanged?.((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const syncStatus = async () => {
      try {
        const current = await platform.getWebRemoteControlStatus();
        if (cancelled) return;
        setSnapshot(current);
        // 仅当快照属于同一目标、或已连上手机（跨 workspace 也要保住链路）时才复用，
        // 否则为当前 workspace 重新 start；避免其他 workspace 的旧会话把状态卡在 starting。
        const isReusableTarget =
          isSameWebRemoteControlTarget(
            current,
            params.workspacePath,
            params.workspaceIdentity,
            params.remoteSessionId,
          ) || isReusableWebRemoteControlSession(current);
        const needsStart = !isReusableTarget;
        if (needsStart && openedRef.current) {
          setBusy(true);
          try {
            const started = await platform.startWebRemoteControl({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              remoteSessionId: params.remoteSessionId,
            });
            if (!cancelled) {
              setSnapshot(started.status === "cancelled" ? { status: "idle" } : started);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!cancelled) {
              setSnapshot({ status: "error", workspacePath: params.workspacePath, error: message });
              toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
            }
          } finally {
            if (!cancelled) setBusy(false);
          }
        }
      } catch {
        // 状态读取失败不打断弹层；轮询会重试。
      }
    };
    void syncStatus();
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const current = await platform.getWebRemoteControlStatus();
          if (!cancelled) setSnapshot(current);
        } catch {
          // ignore：轮询兜底失败保持最后一次快照
        }
      })();
    }, 1000);
    return () => {
      cancelled = true;
      openedRef.current = false;
      window.clearInterval(timer);
      disposeStatus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 开层时按当前 workspace 同步一次
  }, [
    params.open,
    params.workspacePath,
    params.workspaceIdentity,
    params.remoteSessionId,
    platform,
    intl,
  ]);

  // 清单同步：远控运行期间每 5s 把当前窗口的工作区/任务推给桌面运行时，
  // 移动端 bootstrap / workspace-list 才能看到「当前设备上的工作区和任务」。
  useEffect(() => {
    if (!params.open || !params.loadSyncPayload) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const payload = await params.loadSyncPayload?.();
        if (cancelled || !payload) return;
        await platform.syncWebRemoteControlWorkspaces({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          workspaces: payload.workspaces,
        });
        await platform.syncWebRemoteControlTasks({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          tasks: payload.tasks,
        });
      } catch {
        // 同步失败不影响弹层；下一周期重试。
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 开层期间按周期同步
  }, [params.open, params.workspacePath, params.workspaceIdentity, platform]);

  useEffect(() => {
    if (!qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    setQrDataUrl(null);
    void import("qrcode")
      .then((module) => module.toDataURL(qrUrl, { margin: 1, width: 320 }))
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const started = await platform.startWebRemoteControl({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId,
      });
      setSnapshot(started.status === "cancelled" ? { status: "idle" } : started);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
    } finally {
      setBusy(false);
    }
  }, [platform, params.workspacePath, params.workspaceIdentity, params.remoteSessionId, intl]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await platform.stopWebRemoteControl();
      setSnapshot({ status: "idle" });
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
    } finally {
      setBusy(false);
    }
  }, [platform, intl]);

  const refreshPairing = useCallback(async () => {
    setBusy(true);
    try {
      const refreshed = await platform.refreshWebRemoteControlPairing({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      setSnapshot(refreshed.status === "cancelled" ? { status: "idle" } : refreshed);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.success" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.failed" }, { error: message }));
    } finally {
      setBusy(false);
    }
  }, [platform, params.workspacePath, params.workspaceIdentity, intl]);

  const copyLink = useCallback(async () => {
    if (!qrUrl) return;
    try {
      await navigator.clipboard.writeText(qrUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
    }
  }, [qrUrl, intl]);

  return {
    status: snapshot?.status ?? "idle",
    snapshot,
    busy,
    qrDataUrl,
    qrUrl,
    start,
    stop,
    refreshPairing,
    copyLink,
  };
}
