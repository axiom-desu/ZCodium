import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateTraceId } from "@zcode/shared";
import {
  MobileRemoteControlClient,
  readPairingParamsFromLocation,
  type MobileConnectionState,
} from "./protocol.js";
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
 */

type View = { kind: "home" } | { kind: "task"; task: WebRemoteControlTaskRef };

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function MobileApp() {
  const [params, setParams] = useState<ReturnType<typeof readPairingParamsFromLocation> | null>(
    null,
  );
  const [paramsError, setParamsError] = useState<string | null>(null);
  const clientRef = useRef<MobileRemoteControlClient | null>(null);
  const [connection, setConnection] = useState<MobileConnectionState>("connecting");
  const [bootstrap, setBootstrap] = useState<WebRemoteControlBootstrapResult | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [organize, setOrganize] = useState<"timeline" | "workspace">("timeline");
  const [sortBy, setSortBy] = useState<"created" | "updated">("updated");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      setParams(readPairingParamsFromLocation());
    } catch (error) {
      setParamsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const requestId = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await client.request({
      zcode_type: "bootstrap-request",
      requestId,
    });
    if (response.zcode_type === "bootstrap-response") {
      setBootstrap(response.result);
    }
  }, []);

  useEffect(() => {
    if (!params) return;
    const client = new MobileRemoteControlClient(params, {
      onStateChange: (state) => setConnection(state),
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
        if (payload.zcode_type === "app-error") {
          setNotice(payload.error ?? payload.reason);
        }
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
    void refreshBootstrap().catch((error) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    );
  }, [connection, bootstrap, refreshBootstrap]);

  // 任务视图：拉历史 + 周期刷新（实时流接入见 spec 分期 P3 后续）。
  useEffect(() => {
    if (view.kind !== "task") return;
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;
    const load = async () => {
      // rpc-frame 只有桌面 bridge 存在时才被接收，先握手再取服务代理。
      await client.ensureWorkspaceBridge({
        workspaceKey: view.task.workspaceKey,
        taskId: view.task.taskId,
      });
      const { zcodeSessionService: sessionService } = client.createServiceAccessor();
      const workspace = bootstrap?.workspaces.find(
        (item) => item.workspaceKey === view.task.workspaceKey,
      );
      const taskId = view.task.taskId;
      const read = await sessionService.readSessionMessages({
        sessionId: taskId,
        workspacePath: workspace?.workspacePath ?? "",
        workspaceIdentity: workspace?.workspaceIdentity,
        remoteSessionId: workspace?.remoteSessionId,
        limit: 100,
      });
      if (cancelled) return;
      setMessages(
        read.map((message) => toChatMessage(message as Parameters<typeof toChatMessage>[0])),
      );
    };
    void load().catch(() => undefined);
    const timer = window.setInterval(() => void load().catch(() => undefined), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [view, bootstrap]);

  const sendPrompt = useCallback(async () => {
    const client = clientRef.current;
    const content = draft.trim();
    if (!client || view.kind !== "task" || !content) return;
    const workspace = bootstrap?.workspaces.find(
      (item) => item.workspaceKey === view.task.workspaceKey,
    );
    await client.ensureWorkspaceBridge({
      workspaceKey: view.task.workspaceKey,
      taskId: view.task.taskId,
    });
    const { zcodeTaskService: taskService } = client.createServiceAccessor();
    setDraft("");
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: "user", text: content },
    ]);
    // workspace 归属由 taskId 反查（task meta 持久化 workspacePath/Identity）；
    // 远端工作区的 session 路由显式带上 remoteSessionId。
    await taskService.sendPrompt({
      taskId: view.task.taskId,
      traceId: generateTraceId(view.task.taskId),
      content,
      clientMode: "web-remote-replayable",
      remoteSessionId: workspace?.remoteSessionId,
    });
  }, [draft, view, bootstrap]);

  const groupedWorkspaces = useMemo(() => {
    const workspaces = bootstrap?.workspaces ?? [];
    const tasks = bootstrap?.tasks ?? [];
    const sorted = [...tasks].sort((a, b) => {
      if (sortBy === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
    if (organize === "timeline") {
      return [{ key: "timeline", label: null, tasks: sorted }];
    }
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
        title={`任务会话`}
        onBack={() => setView({ kind: "home" })}
        notice={notice}
      >
        <div className="flex flex-col gap-3 pb-24">
          {messages.map((message) => (
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
          {messages.length === 0 ? (
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
      onRefresh={() => void refreshBootstrap().catch(() => undefined)}
      notice={notice}
    >
      <section className="space-y-1">
        <h1 className="text-ui-lg font-medium text-foreground">ZCode 远程控制</h1>
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
          {connection === "paired" ? "已连接到当前桌面窗口" : "未连接"}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {bootstrap?.workspaces.length ?? 0} 个工作区 · {bootstrap?.tasks.length ?? 0} 个任务
        </span>
      </section>
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

/** ZCodeMessageWithParts → 移动端纯文本气泡（v1 只渲染文本 part）。 */
function toChatMessage(message: {
  id?: string;
  role?: string;
  parts?: unknown[];
  text?: string;
}): ChatMessage {
  const record = message;
  const text =
    typeof record.text === "string"
      ? record.text
      : (record.parts ?? [])
          .map((part) => {
            const item = part as { type?: string; text?: string };
            return item.type === "text" && typeof item.text === "string" ? item.text : "";
          })
          .filter(Boolean)
          .join("\n");
  return {
    id: record.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    role: record.role === "user" ? "user" : "assistant",
    text,
  };
}

function Shell(props: {
  connection?: MobileConnectionState;
  title?: string;
  notice?: string | null;
  onBack?: () => void;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
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
      {props.connection && props.connection !== "paired" ? (
        <p className="px-3 py-1 text-center text-ui-xs text-foreground-subtle">
          {props.connection === "closed" ? "连接已断开" : "正在自动重连..."}
        </p>
      ) : null}
      {props.notice ? (
        <p className="px-3 py-1 text-center text-ui-xs text-destructive">{props.notice}</p>
      ) : null}
      <main className="flex flex-col gap-4 p-3">{props.children}</main>
    </div>
  );
}

export type { WebRemoteControlAppPayload, WebRemoteControlWorkspaceRef };
