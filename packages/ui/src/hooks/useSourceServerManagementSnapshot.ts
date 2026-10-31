import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { shouldApplySourceManagementSnapshot } from "@/lib/sourceServerManagement.js";

interface SourceServerManagementSnapshotState {
  management: ISourceServerManagementService | undefined;
  snapshot: SourceServerManagementSnapshot | null;
  ready: boolean;
  applySnapshot: (snapshot: SourceServerManagementSnapshot) => void;
  refresh: () => void;
}

/**
 * Source 管理快照的唯一取数入口（既有 Host 服务 accessor）。
 *
 * - state/directory 事件只触发重读，不在 UI 累积历史；
 * - 重读 in-flight 期间的新事件合并成一次排队刷新，避免事件风暴；
 * - generation 只进不退，晚到旧快照直接丢弃。
 */
export function useSourceServerManagementSnapshot(
  options: { enabled?: boolean } = {},
): SourceServerManagementSnapshotState {
  const enabled = options.enabled ?? true;
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const observedGenerationRef = useRef(-1);
  const [snapshot, setSnapshot] = useState<SourceServerManagementSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshotOwner, setSnapshotOwner] = useState(management);
  const refreshRef = useRef<() => void>(() => undefined);

  const applySnapshot = useCallback(
    (next: SourceServerManagementSnapshot) => {
      if (!shouldApplySourceManagementSnapshot(observedGenerationRef.current, next.generation)) {
        return;
      }
      observedGenerationRef.current = next.generation;
      setSnapshotOwner(management);
      setSnapshot(next);
      setReady(true);
    },
    [management],
  );

  useEffect(() => {
    if (!management || !enabled) {
      observedGenerationRef.current = -1;
      setSnapshot(null);
      setReady(false);
      refreshRef.current = () => undefined;
      return undefined;
    }

    // generation 只在同一服务 owner 内单调；新 Host 可从 0 开始，不能沿用旧在线事实。
    observedGenerationRef.current = -1;
    setReady(false);
    let disposed = false;
    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let refreshQueuedMigrationCounts = false;
    const refresh = (refreshMigrationCounts = false): void => {
      if (refreshInFlight) {
        refreshQueued = true;
        refreshQueuedMigrationCounts ||= refreshMigrationCounts;
        return;
      }
      refreshInFlight = management
        .getSnapshot({ refreshMigrationCounts })
        .then((next) => {
          if (!disposed) applySnapshot(next);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          setReady(false);
          logger.warn("[source-management] 读取 Source 管理快照失败", error);
        })
        .finally(() => {
          refreshInFlight = null;
          if (!disposed && refreshQueued) {
            refreshQueued = false;
            const refreshCounts = refreshQueuedMigrationCounts;
            refreshQueuedMigrationCounts = false;
            refresh(refreshCounts);
          }
        });
    };

    // 统计完成也会触发目录事件；只有显式进入/刷新才主动重读 migration counts，避免事件反馈成轮询。
    refreshRef.current = () => refresh(true);
    refresh(true);
    const stateSubscription = management.onDidChangeState(() => refresh());
    const directorySubscription = management.onDidChangeDirectory?.(() => refresh());
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      stateSubscription.dispose();
      directorySubscription?.dispose();
    };
  }, [applySnapshot, enabled, management]);

  return {
    management,
    snapshot: enabled && snapshotOwner === management ? snapshot : null,
    ready: enabled && snapshotOwner === management && ready,
    applySnapshot,
    refresh: useCallback(() => refreshRef.current(), []),
  };
}
