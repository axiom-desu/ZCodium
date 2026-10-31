/* eslint-disable max-lines -- 移动端首页与会话共享连接态，避免拆分状态投影所有权。 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  MobileRemoteControlClient,
  readPairingParamsFromLocation,
  type MobileConnectionState,
} from "./protocol.js";
import {
  presentMobileConnection,
  type MobileConnectionSnapshot,
} from "./connectionPresentation.js";
import {
  conversationReducer,
  initialConversationState,
  type ConversationScope,
} from "./conversationReducer.js";
// 手机首页目录 hook 走 @zcode/ui 公开子入口；不再跨包深引 ui/src 文件路径。
import { useMobileProjectDirectory } from "@zcode/ui/mobile-project-directory";
import { Button } from "../../../ui/src/components/ui/button.js";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";
import { findKnownDeviceDisplay, rememberKnownDeviceDisplay } from "./knownDeviceDisplayCache.js";
import { logger } from "../../../ui/src/logger.js";
import type {
  WebRemoteControlBootstrapResult,
  WebRemoteControlAppPayload,
  WebRemoteControlTaskRef,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";

/**
 * 移动端远控应用：mobileHome（工作区/任务列表） + mobileShell（任务会话）。
 * 会话内容经 rpc 桥读桌面 Host；发送走 IZCodeTaskService.sendPrompt，
 * clientMode 固定 web-remote-replayable（与桌面 continuous 语义分离）。
 *
 * 实时更新走 Host replayable 事件流订阅（`onDynamicTaskEvent`），不再周期轮询：
 * 首次/恢复读取 `readSessionMessages` 作为快照屏障，在途事件使读取过期时由控制器补读。
 */

type View = { kind: "home" } | { kind: "task"; task: WebRemoteControlTaskRef };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findWorkspace(
  bootstrap: WebRemoteControlBootstrapResult | null,
  workspaceKey: string,
): WebRemoteControlWorkspaceRef | undefined {
  return bootstrap?.workspaces.find((item) => item.workspaceKey === workspaceKey);
}

export function MobileApp() {
  const [params, setParams] = useState<ReturnType<typeof readPairingParamsFromLocation> | null>(
    null,
  );
  const [paramsError, setParamsError] = useState<string | null>(null);
  // 仅用于首页展示的桌面名；权威值来自本次 pairing URL，URL 缺省时才读有界显示缓存。
  const [knownDeviceName, setKnownDeviceName] = useState<string | null>(null);
  const clientRef = useRef<MobileRemoteControlClient | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<MobileConnectionSnapshot>({
    state: "connecting",
  });
  const connection = connectionSnapshot.state;
  const [bootstrap, setBootstrap] = useState<WebRemoteControlBootstrapResult | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [organize, setOrganize] = useState<"timeline" | "workspace">("timeline");
  const [sortBy, setSortBy] = useState<"created" | "updated">("updated");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [conversation, dispatchConversation] = useReducer(
    conversationReducer,
    initialConversationState,
  );
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const directory = useMobileProjectDirectory(
    clientRef.current,
    bootstrap?.workspaces.find((w) => w.connectionState !== "disconnected")?.workspaceKey,
    connection === "paired" && view.kind === "home",
    bootstrap ?? undefined,
  );
  // 传输降级回调由「订阅 effect」注册：`onPayload` 在 client 构造时绑定，
  // 之后通过 ref 把 bridge-degraded 路由到当前 task 的完整桥恢复。
  const onTransportDegradedRef = useRef<() => void>(() => {});

  const reportError = useCallback((message: string, error: unknown) => {
    logger.error(message, error);
    setNotice(describeError(error));
  }, []);

  useEffect(() => {
    try {
      const parsed = readPairingParamsFromLocation();
      const pairingName = parsed.deviceName?.trim() || null;
      setParams(parsed);
      setKnownDeviceName(pairingName ?? findKnownDeviceDisplay(parsed.deviceMid)?.name ?? null);
      if (parsed.deviceMid && pairingName) {
        rememberKnownDeviceDisplay({
          deviceMid: parsed.deviceMid,
          name: pairingName,
          appVersion: parsed.appVersion,
        });
      }
    } catch (error) {
      setParamsError(describeError(error));
    }
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const response = await client.request({
      zcode_type: "bootstrap-request",
      requestId: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    if (response.zcode_type === "bootstrap-response") setBootstrap(response.result);
  }, []);

  useEffect(() => {
    if (!params) return;
    const client = new MobileRemoteControlClient(params, {
      onStateChange: (state, detail) => setConnectionSnapshot({ state, detail }),
      onPayload: (payload) => {
        if (payload.zcode_type === "workspace-list-updated") {
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  workspaces: payload.result.workspaces,
                  tasks: payload.result.tasks,
                }
              : current,
          );
        }
        if (payload.zcode_type === "bridge-degraded") onTransportDegradedRef.current();
        if (payload.zcode_type === "app-error") setNotice(payload.error ?? payload.reason);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [params]);

  // 网络恢复 / 页面回到前台时立刻补一次重连；其余情况交给客户端内部的退避重连。
  useEffect(() => {
    const onOnline = () => clientRef.current?.retryNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") clientRef.current?.retryNow();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (connection !== "paired" || bootstrap) return;
    void refreshBootstrap().catch((error) => reportError("[mobile] bootstrap 拉取失败", error));
  }, [connection, bootstrap, refreshBootstrap, reportError]);

  // 任务视图订阅：进入任务即订阅 Host replayable 事件流；退出/换 workspace 释放旧订阅。
  // 断线重连（connection 重新变 paired）会重跑本 effect：重开 bridge + 重订阅 + 重读快照。
  useEffect(() => {
    if (view.kind !== "task" || connection !== "paired") return;
    const client = clientRef.current;
    if (!client) return;
    const { workspaceKey, taskId } = view.task;
    const scope: ConversationScope = { workspaceKey, taskId };
    const workspace = findWorkspace(bootstrap, workspaceKey);
    const lifecycle = new TaskConversationLifecycle(scope, {
      subscribe: (onEvent) =>
        client.subscribeTaskStream(
          {
            workspaceKey,
            workspacePath: workspace?.workspacePath ?? "",
            workspaceIdentity: workspace?.workspaceIdentity,
            taskId,
          },
          onEvent,
        ),
      read: () =>
        client.readTaskSnapshot({
          workspaceKey,
          taskId,
          workspacePath: workspace?.workspacePath ?? "",
          workspaceIdentity: workspace?.workspaceIdentity,
          remoteSessionId: workspace?.remoteSessionId,
          limit: 100,
        }),
      dispatch: dispatchConversation,
      onError: (error) => reportError("[mobile] 会话同步失败", error),
    });
    // 协议先作废 bridge，控制器再重订阅/补读；不依赖 flags 变化触发 React effect。
    onTransportDegradedRef.current = () => lifecycle.recoverBridge();
    lifecycle.start();
    return () => {
      lifecycle.dispose();
      onTransportDegradedRef.current = () => {};
    };
  }, [view, bootstrap, connection, reportError]);

  const sendPrompt = useCallback(async () => {
    const client = clientRef.current;
    const content = draft.trim();
    if (!client || view.kind !== "task" || !content) return;
    const { workspaceKey, taskId } = view.task;
    const workspace = findWorkspace(bootstrap, workspaceKey);
    setDraft("");
    dispatchConversation({
      type: "appendOptimisticUserMessage",
      scope: { workspaceKey, taskId },
      id: `local-${Date.now()}`,
      text: content,
    });
    try {
      await client.sendTaskPrompt({
        workspaceKey,
        taskId,
        content,
        remoteSessionId: workspace?.remoteSessionId,
      });
    } catch (error) {
      reportError("[mobile] 发送消息失败", error);
    }
  }, [draft, view, bootstrap, reportError]);

  const groupedWorkspaces = useMemo(() => {
    const workspaces = bootstrap?.workspaces ?? [];
    const tasks = bootstrap?.tasks ?? [];
    const sorted = [...tasks].sort((a, b) => {
      if (sortBy === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
    if (organize === "timeline") return [{ key: "timeline", label: null, tasks: sorted }];
    return workspaces.map((workspace) => ({
      key: workspace.workspaceKey,
      label: workspace.label ?? workspace.workspacePath,
      tasks: sorted.filter((task) => task.workspaceKey === workspace.workspaceKey),
    }));
  }, [bootstrap, organize, sortBy]);

  if (paramsError) {
    return (
      <Shell notice={paramsError}>
        <p className="text-ui-base text-foreground-subtle">
          远程控制链接无效，请回到桌面端重新生成二维码。
        </p>
      </Shell>
    );
  }

  if (view.kind === "task") {
    return (
      <Shell
        connection={connection}
        connectionDetail={connectionSnapshot.detail}
        title={`任务会话`}
        onBack={() => setView({ kind: "home" })}
        notice={notice}
      >
        <div className="flex flex-col gap-3 pb-24">
          {conversation.messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "self-end max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-ui-base text-primary-foreground"
                  : "self-start max-w-[85%] rounded-2xl bg-surface px-3 py-2 text-ui-base text-foreground"
              }
            >
              {message.text}
            </div>
          ))}
          {conversation.messages.length === 0 ? (
            <p className="text-center text-ui-base text-foreground-subtle">暂无消息</p>
          ) : null}
        </div>
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="发送消息"
              className="h-10 flex-1 rounded-lg border border-input-border bg-surface px-3 text-ui-base text-foreground"
            />
            <button
              type="button"
              className="h-10 rounded-lg bg-primary px-4 text-ui-base font-medium text-primary-foreground disabled:opacity-50"
              disabled={!draft.trim()}
              onClick={() => void sendPrompt()}
            >
              发送
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      connection={connection}
      connectionDetail={connectionSnapshot.detail}
      onRefresh={() =>
        void refreshBootstrap().catch((error) => reportError("[mobile] 刷新工作区失败", error))
      }
      notice={notice}
    >
      <section className="space-y-1">
        <h1 className="text-ui-lg font-medium text-foreground">ZCode 远程控制</h1>
        {knownDeviceName ? (
          <p data-testid="mobile-known-device-name" className="text-ui-base text-foreground-subtle">
            桌面设备：{knownDeviceName}
          </p>
        ) : null}
        <p className="text-ui-base/relaxed text-foreground-subtle">
          本次连接可以查看当前设备上已打开的项目、任务和会话；二维码失效后需要回到桌面端重新连接。
        </p>
      </section>
      <section className="flex flex-wrap items-center gap-2">
        <span
          className={
            connection === "paired"
              ? "inline-flex h-6 items-center rounded-full border border-border px-2 text-ui-xs font-medium text-foreground"
              : "inline-flex h-6 items-center rounded-full border border-border px-2 text-ui-xs font-medium text-foreground-subtle"
          }
        >
          {presentMobileConnection(connection, connectionSnapshot.detail).label}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {bootstrap?.workspaces.length ?? 0} 个工作区 · {bootstrap?.tasks.length ?? 0} 个任务
        </span>
      </section>
      {directory.roots ? (
        <section aria-label="项目目录 / Project directory" className="space-y-2">
          <h2 className="text-ui-base font-medium">项目目录 / Project directory</h2>
          <ul className="space-y-2">
            {directory.roots.map((root) => {
              const workspace = bootstrap?.workspaces.find(
                (w) =>
                  w.workspacePath === root.rootIdentity.rootPath &&
                  w.workspaceIdentity === root.workspaceIdentity &&
                  w.remoteSessionId === root.remoteSessionId &&
                  w.connectionState !== "disconnected",
              );
              const enabled = root.enabled && Boolean(workspace);
              return (
                <li
                  key={JSON.stringify(root.rootIdentity)}
                  className="rounded-xl border border-border bg-card p-3"
                >
                  <p className="text-ui-base">{root.projectName}</p>
                  <p className="break-all font-mono text-ui-sm text-foreground-subtle">
                    {root.rootIdentity.hostId} · {root.rootIdentity.rootPath}
                  </p>
                  <Button
                    variant="outline"
                    disabled={!enabled || directory.pending}
                    onClick={() => {
                      if (!enabled || !workspace) return;
                      void directory.create(root).then((task) => {
                        if (!task) return;
                        setView({
                          kind: "task",
                          task: {
                            workspaceKey: workspace.workspaceKey,
                            taskId: task.taskId,
                            title: task.title,
                            remoteSessionId: root.remoteSessionId,
                          },
                        });
                        void refreshBootstrap().catch((error) =>
                          reportError("[mobile] 刷新工作区失败", error),
                        );
                      });
                    }}
                  >
                    新建任务 / New task
                  </Button>
                  {!enabled ? (
                    <p className="text-ui-sm text-foreground-subtle">
                      请在桌面端打开 / Open on desktop
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {directory.error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {directory.error}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() =>
            setOrganize((current) => (current === "timeline" ? "workspace" : "timeline"))
          }
        >
          整理任务：{organize === "timeline" ? "按时间线" : "按工作区"}
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() => setSortBy((current) => (current === "updated" ? "created" : "updated"))}
        >
          排序：{sortBy === "updated" ? "更新时间" : "创建时间"}
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() =>
            setCollapsed(
              collapsed.size > 0 ? new Set() : new Set(groupedWorkspaces.map((group) => group.key)),
            )
          }
        >
          {collapsed.size > 0 ? "展开全部" : "收起全部"}
        </button>
      </section>
      <section className="space-y-4">
        {groupedWorkspaces.map((group) => (
          <div key={group.key} className="space-y-2">
            {group.label ? (
              <h2 className="text-ui-base font-medium text-foreground">{group.label}</h2>
            ) : null}
            {collapsed.has(group.key) ? null : group.tasks.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">这个工作区暂无任务</p>
            ) : (
              <ul className="space-y-2">
                {group.tasks.map((task) => (
                  <li key={task.taskId}>
                    <button
                      type="button"
                      className="w-full rounded-xl border border-border bg-card p-3 text-left"
                      onClick={() => setView({ kind: "task", task })}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                          {task.title}
                        </span>
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {taskStatusLabel(task.displayStatus)}
                        </span>
                      </div>
                      {typeof task.updatedAt === "number" ? (
                        <div className="mt-1 text-ui-xs text-foreground-subtle">
                          更新于 {new Date(task.updatedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>
    </Shell>
  );
}

function taskStatusLabel(status: WebRemoteControlTaskRef["displayStatus"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "error":
      return "错误";
    default:
      return "空闲";
  }
}

function Shell(props: {
  connection?: MobileConnectionState;
  connectionDetail?: MobileConnectionSnapshot["detail"];
  title?: string;
  notice?: string | null;
  onBack?: () => void;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const connectionPresentation = props.connection
    ? presentMobileConnection(props.connection, props.connectionDetail)
    : null;
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        {props.onBack ? (
          <button type="button" className="text-ui-base text-primary" onClick={props.onBack}>
            返回任务首页
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
          {props.title ?? "ZCode 远程控制"}
        </span>
        {props.onRefresh ? (
          <button type="button" className="text-ui-xs text-primary" onClick={props.onRefresh}>
            刷新
          </button>
        ) : null}
      </header>
      {connectionPresentation && props.connection !== "paired" ? (
        <div
          className={`px-3 py-1 text-center text-ui-xs ${connectionPresentation.terminal ? "text-destructive" : "text-foreground-subtle"}`}
          role="status"
        >
          <p className="font-medium">{connectionPresentation.label}</p>
          <p>{connectionPresentation.description}</p>
        </div>
      ) : null}
      {props.notice ? (
        <p className="px-3 py-1 text-center text-ui-xs text-destructive">{props.notice}</p>
      ) : null}
      <main className="flex flex-col gap-4 p-3">{props.children}</main>
    </div>
  );
}

export type { WebRemoteControlAppPayload, WebRemoteControlWorkspaceRef };
