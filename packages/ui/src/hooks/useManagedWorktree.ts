import { useCallback, useEffect, useMemo, useState } from "react";
import type { ManagedWorktreeGroup } from "@zcode/shared/managed-worktree";
import { useOptionalServices } from "./useServices.js";

/**
 * 受管 worktree 的唯一 UI 消费者：只读服务事实，命令都交给 Host。
 * 旧 Host/远端/手机没有该服务时 available=false，入口隐藏而不是回退到本地 git。
 */
export function useManagedWorktree(projectId: string | null) {
  const services = useOptionalServices();
  const service = services?.managedWorktreeService;
  const [groups, setGroups] = useState<ManagedWorktreeGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capable, setCapable] = useState(false);

  const refresh = useCallback(async () => {
    if (!service || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await service.listWorktrees({ projectId });
      setGroups(result.groups);
    } catch (cause) {
      setGroups([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // 旧 CLI 会丢弃 worktree cwd；创建/删除入口只在能力声明后开放。
    let current = true;
    setCapable(false);
    if (!service || !projectId) return () => {};
    void service
      .supportsWorktreeCwd({ projectId })
      .then((value) => {
        if (current) setCapable(value);
      })
      .catch(() => {
        if (current) setCapable(false);
      });
    return () => {
      current = false;
    };
  }, [projectId, service]);

  const createTask = useCallback(
    async (ref: string | null) => {
      if (!service || !projectId || !capable) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await service.createTask({ projectId, ref });
        if (!result.ok) {
          setError(`${result.error.code}${result.error.detail ? `: ${result.error.detail}` : ""}`);
          return null;
        }
        await refresh();
        return result.value;
      } finally {
        setBusy(false);
      }
    },
    [capable, projectId, refresh, service],
  );

  const removeWorktree = useCallback(
    async (worktreeRoot: string, force: boolean) => {
      if (!service || !projectId) return false;
      setBusy(true);
      setError(null);
      try {
        const result = await service.removeWorktree({ projectId, worktreeRoot, force });
        if (!result.ok) {
          setError(`${result.error.code}${result.error.detail ? `: ${result.error.detail}` : ""}`);
          return false;
        }
        await refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [capable, projectId, refresh, service],
  );

  return useMemo(
    () => ({
      available: Boolean(service && projectId),
      capable,
      groups,
      loading,
      busy,
      error,
      refresh,
      createTask,
      removeWorktree,
    }),
    [
      busy,
      capable,
      createTask,
      error,
      groups,
      loading,
      projectId,
      refresh,
      removeWorktree,
      service,
    ],
  );
}
