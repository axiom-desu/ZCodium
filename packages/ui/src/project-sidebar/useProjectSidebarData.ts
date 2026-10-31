import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectTree } from "./contract.js";
import { useServices } from "@/hooks/useServices.js";

const PROJECT_INVALIDATED_CHANNEL = "state:projects";

declare const projectSidebarToken: unique symbol;
/** 只能由 readTree owner 发出，调用方不能从数字重建资格。 */
export type ProjectSidebarToken = { readonly [projectSidebarToken]: true };
export interface ProjectSidebarScope {
  token: ProjectSidebarToken;
  isCurrentToken(token: ProjectSidebarToken): boolean;
}

interface ProjectSidebarDataState extends ProjectSidebarScope {
  tree: ProjectTree | null;
  loading: boolean;
  error: string | null;
  supported: boolean;
  refresh(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceScopeKey(path: string, identity?: string): string {
  return JSON.stringify([identity?.trim() || path]);
}

/**
 * 唯一读取入口：Host IProjectService.readTree。请求序号拒绝迟到结果，
 * scope/service 换代使旧结果和旧命令资格同时失效；不缓存第二份项目/任务行。
 */
export function useProjectSidebarData(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ProjectSidebarDataState {
  const services = useServices();
  const service = services.projectService;
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [loading, setLoading] = useState(Boolean(service));
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<ProjectTree | null>(null);
  const scopeKey = JSON.stringify([params.workspacePath, params.workspaceIdentity?.trim() || ""]);
  const token = useMemo(() => ({}) as ProjectSidebarToken, [scopeKey, service]);
  const generationRef = useRef({ token, alive: true });
  // render 已切 scope/service 时就拒绝旧闭包，不能等 effect 才撤销资格。
  if (generationRef.current.token !== token) generationRef.current = { token, alive: true };
  const isCurrentToken = useCallback(
    (candidate: ProjectSidebarToken) =>
      generationRef.current.alive && generationRef.current.token === candidate,
    [],
  );
  const requestSeqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    // 旧命令中的 refresh 仍捕获旧 service；必须在 IO 前验票，不能借新代际读旧服务。
    if (!service || !isCurrentToken(token)) return;
    const requestSeq = ++requestSeqRef.current;
    if (!treeRef.current) setLoading(true);
    try {
      const next = await service.readTree({ includeDeleted: true, includeDeletedTasks: false });
      if (!isCurrentToken(token) || requestSeq !== requestSeqRef.current) return;
      treeRef.current = next;
      setTree(next);
      setError(null);
      setLoading(false);
    } catch (cause) {
      if (!isCurrentToken(token) || requestSeq !== requestSeqRef.current) return;
      setError(errorMessage(cause));
      setLoading(false);
    }
  }, [isCurrentToken, service, token]);

  useLayoutEffect(() => {
    generationRef.current.alive = true;
    requestSeqRef.current += 1;
    treeRef.current = null;
    setTree(null);
    setError(null);
    setLoading(Boolean(service));
    if (service) void refresh();
    return () => {
      // cleanup 只能撤销自己的代际，不能把 render 已安装的新 owner 标成失效。
      if (generationRef.current.token === token) generationRef.current.alive = false;
      requestSeqRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [refresh, service, token]);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === PROJECT_INVALIDATED_CHANNEL) void refresh();
    });
    return () => disposable.dispose();
  }, [refresh, services.broadcastService]);

  const workspaceScopes = useMemo(() => {
    const scopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
    const add = (workspacePath: string, workspaceIdentity?: string) => {
      const key = workspaceScopeKey(workspacePath, workspaceIdentity);
      if (!scopes.has(key)) {
        scopes.set(key, {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
      }
    };
    add(params.workspacePath, params.workspaceIdentity);
    for (const project of tree?.projects ?? []) {
      if (project.deleted) continue;
      for (const root of project.roots) add(root.rootPath);
    }
    for (const task of tree?.tasks ?? []) add(task.workspacePath, task.workspaceIdentity);
    return [...scopes.values()];
  }, [params.workspaceIdentity, params.workspacePath, tree]);
  const scopesSignature = useMemo(
    () =>
      workspaceScopes
        .map((scope) => workspaceScopeKey(scope.workspacePath, scope.workspaceIdentity))
        .join("|"),
    [workspaceScopes],
  );

  useEffect(() => {
    if (!service || workspaceScopes.length === 0) return;
    const scheduleRefresh = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // 一次 sessions-index 收敛可能连续发多条 workspace 事件；合并为本轮读取，
      // 读取本身仍由请求序号/代际判定，不用延时掩盖同步失败。
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void refresh();
      }, 16);
    };
    const disposables = workspaceScopes.flatMap((scope) => {
      const subscribe = services.zcodeTaskService.onDynamicWorkspaceEvent(scope);
      return [
        subscribe((event) => {
          if (event.type === "workspace_task_list_changed") scheduleRefresh();
        }),
      ];
    });
    return () => {
      for (const disposable of disposables) disposable.dispose();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [refresh, scopesSignature, service, services.zcodeTaskService, workspaceScopes]);

  return {
    tree,
    loading,
    error,
    token,
    isCurrentToken,
    supported: Boolean(service),
    refresh,
  };
}
