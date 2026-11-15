import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectCatalog, RemoteProjectEntry } from "@zcode/services";
import { useOptionalServices } from "./useServices.js";

/**
 * 本机远端项目入口 intent 的唯一 UI 消费者。
 * 列表来自 RemoteProjectService；catalog 只做本机项目 + 远端入口的只读组合。
 * 移除入口/恢复都是本机 membership/cache 操作，绝不发送远端删除。
 */
export function useRemoteProjects() {
  const services = useOptionalServices();
  const service = services?.remoteProjectService;
  const [entries, setEntries] = useState<RemoteProjectEntry[]>([]);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const [nextEntries, nextCatalog] = await Promise.all([
        service.listEntries(),
        service.readCatalog(),
      ]);
      setEntries(nextEntries);
      setCatalog(nextCatalog);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeEntry = useCallback(
    async (entryId: string) => {
      if (!service) return false;
      setBusy(true);
      setError(null);
      try {
        await service.removeEntry({ entryId });
        await refresh();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, service],
  );

  const restoreEntry = useCallback(
    async (entryId: string) => {
      if (!service) return false;
      setBusy(true);
      setError(null);
      try {
        await service.restoreEntry({ entryId });
        await refresh();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, service],
  );

  return useMemo(
    () => ({
      available: Boolean(service),
      entries,
      catalog,
      loading,
      busy,
      error,
      refresh,
      removeEntry,
      restoreEntry,
    }),
    [busy, catalog, entries, error, loading, refresh, removeEntry, restoreEntry, service],
  );
}
