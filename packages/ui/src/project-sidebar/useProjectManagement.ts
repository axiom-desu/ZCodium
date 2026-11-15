import { useCallback, useRef, useState } from "react";
import type { ProjectTree, VirtualProject } from "./contract.js";
import type { ProjectManagementRow } from "./project-management-view.js";
import { dismissToast, toast, updateToast, type ToastUpdate } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { formatCountMessage, isProjectDataCandidate } from "./project-management-view.js";

/** 本批成功移除的项；撤销时按原 projectId / hostId 重新恢复。 */
interface RemovedProject {
  row: ProjectManagementRow;
}
export interface ProjectManagementFailure {
  kind: "remove" | "undo" | "restore" | "purge";
  count: number;
  name: string;
  reason: string;
  retry(): Promise<void>;
}

/** 确认对话框里「同时删除 ZCode 数据」的测量汇总；只含本机候选。 */
export interface ProjectDataTotals {
  projects: number;
  sessions: number;
  sessionBytes: number;
  checkpointBytes: number;
  memoryBytes: number;
  totalBytes: number;
}
export interface ProjectRemovalOptions {
  /** 勾选删除数据时为确认时的测量总量；重试时可缺省（进度只按项目数推进）。 */
  deleteData?: { totalBytes?: number };
}

/**
 * 项目管理命令编排：只发 IProjectService 命令并重读 readTree owner；行/失败/批次状态只在本 hook。
 * 批次按发起顺序串行，后续操作排队而不是丢弃；撤销 toast 在本批刷新结束后才弹出。
 */
export function useProjectManagement(params: {
  tree: ProjectTree | null;
  refresh: () => Promise<void>;
}) {
  const service = useServices().projectService;
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProjectManagementFailure | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const latest = useRef(params);
  latest.current = params;
  const undoRef = useRef<(removed: readonly RemovedProject[]) => Promise<void>>(async () => {});
  const restoreRef = useRef<(project: VirtualProject) => Promise<void>>(async () => {});

  const format = useCallback(
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    [],
  );

  const resultToast = useCallback(
    (message: string, options?: { actionLabel?: string; onAction?: () => void }) =>
      toast(message, {
        position: "bottom-center",
        dedupeKey: "project-management-result",
        variant: options?.actionLabel ? "info" : "default",
        dismissible: Boolean(options?.actionLabel),
        ...(options?.actionLabel
          ? {
              dismissLabel: intl.formatMessage({ id: "projectManagement.dismiss" }),
              actionLabel: options.actionLabel,
              onAction: options.onAction,
            }
          : {}),
      }),
    [intl],
  );

  const exclusive = useCallback((body: () => Promise<(() => void) | void>) => {
    pending.current++;
    setBusy(true);
    const run = queue.current.then(async () => {
      setFailure(null);
      let report: (() => void) | void = undefined;
      try {
        report = await body();
        await latest.current.refresh();
      } finally {
        if (--pending.current === 0) setBusy(false);
        report?.();
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, []);

  const fail = useCallback(
    (
      kind: ProjectManagementFailure["kind"],
      failed: { name: string; cause: unknown }[],
      retry: () => Promise<void>,
    ) => {
      if (!failed.length) return;
      setFailure({
        kind,
        count: failed.length,
        name: failed[0]!.name,
        reason: format(failed[0]!.cause),
        retry,
      });
    },
    [format],
  );

  /** 只读测量；旧 Agent 不支持、服务不可用时报错由调用方隐藏选项，不返回 0 字节成功。 */
  const measureData = useCallback(
    async (rows: readonly ProjectManagementRow[]): Promise<ProjectDataTotals | null> => {
      const ids = rows.filter(isProjectDataCandidate).map((row) => row.project.id);
      if (!ids.length || !service) return null;
      try {
        const { projects } = await service.measureProjectData(ids, "local");
        const sum = (pick: (entry: (typeof projects)[number]) => number) =>
          projects.reduce((total, entry) => total + pick(entry), 0);
        const totals = {
          projects: ids.length,
          sessions: sum((entry) => entry.sessions),
          sessionBytes: sum((entry) => entry.sessionBytes),
          checkpointBytes: sum((entry) => entry.checkpointBytes),
          memoryBytes: sum((entry) => entry.memoryBytes),
        };
        return {
          ...totals,
          totalBytes: totals.sessionBytes + totals.checkpointBytes + totals.memoryBytes,
        };
      } catch (cause) {
        logger.warn("[project-management] 测量项目数据失败", { count: ids.length, cause });
        throw cause;
      }
    },
    [service],
  );

  /**
   * 逐个删除已移除本机项目的数据，期间显示常驻进度 toast。会话仍在运行而被保留、或有文件删不掉的
   * 项目算失败：它们保持软删除，可恢复，也可只重试这一步。
   */
  const purgeRows = useCallback(
    async (rows: readonly ProjectManagementRow[], totalBytes?: number) => {
      const failed: { row: ProjectManagementRow; cause: unknown }[] = [];
      let freed = 0;
      let done = 0;
      const progressMessage = () =>
        totalBytes
          ? intl.formatMessage(
              { id: "projectManagement.data.progressAmount" },
              { done: formatBytes(freed), total: formatBytes(totalBytes) },
            )
          : formatBytes(freed);
      const id = toast(formatCountMessage(intl, "projectManagement.data.progress", rows.length), {
        position: "bottom-center",
        dedupeKey: "project-management-data-progress",
        durationMs: 0,
      });
      for (const row of rows) {
        try {
          if (!service) throw new Error("project.service-unavailable");
          const result = await service.deleteProjectData(row.project.id, "local");
          freed += result.freedBytes;
          if (result.runningSessions > 0) throw new Error("project.data-session-running");
          if (result.referencedSessions > 0) throw new Error("project.data-session-referenced");
          if (result.failed > 0) throw new Error("project.data-delete-failed");
        } catch (cause) {
          failed.push({ row, cause });
          logger.error("[project-management] 删除项目数据失败", {
            projectId: row.project.id,
            cause,
          });
        }
        done++;
        updateToast(id, { message: progressMessage() } satisfies ToastUpdate);
      }
      dismissToast(id);
      return { freed, failed };
    },
    [intl, service],
  );

  const purge = useCallback(
    (rows: readonly ProjectManagementRow[]) =>
      exclusive(async () => {
        const { freed, failed } = await purgeRows(rows);
        fail(
          "purge",
          failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
          () => purge(failed.map(({ row }) => row)),
        );
        const succeeded = rows.length - failed.length;
        if (!succeeded) return;
        return () =>
          resultToast(
            formatCountMessage(intl, "projectManagement.data.deletedToast", succeeded, {
              size: formatBytes(freed),
            }),
          );
      }),
    [exclusive, fail, intl, purgeRows, resultToast],
  );

  /** purgeAlso：已移除、只差数据删除的项目（上一批数据删除失败、随移除失败一起重试）。 */
  const remove = useCallback(
    (
      rows: readonly ProjectManagementRow[],
      options: ProjectRemovalOptions = {},
      purgeAlso: readonly ProjectManagementRow[] = [],
    ) =>
      exclusive(async () => {
        // 固定确认时的身份集合；之后的刷新、搜索或重复点击不能扩充已经确认的批次。
        const candidates = [...new Map(rows.map((row) => [row.key, row])).values()];
        const removed: RemovedProject[] = [];
        const failed: { row: ProjectManagementRow; cause: unknown }[] = [];
        for (const row of candidates) {
          const current = latest.current;
          // 确认后已被别处删除或不可移除的行直接跳过，不对新状态补发命令。
          const alive = current.tree?.projects.some(
            (project) => project.id === row.project.id && !project.deleted,
          );
          if (!alive || row.removal !== "delete") continue;
          try {
            if (!service) throw new Error("project.service-unavailable");
            await service.deleteProject(row.project.id, row.project.hostId);
            removed.push({ row });
          } catch (cause) {
            failed.push({ row, cause });
            logger.error("[project-management] 移除项目失败", {
              projectId: row.project.id,
              hostId: row.project.hostId,
              cause,
            });
          }
        }
        if (options.deleteData) {
          const local = [
            ...removed.map(({ row }) => row).filter(isProjectDataCandidate),
            ...purgeAlso,
          ];
          // 项目先离开列表，数据删除在后台继续；刷新失败不阻断删除，本批结束时还会再刷新一次。
          if (local.length) await latest.current.refresh().catch(() => {});
          const purged = local.length
            ? await purgeRows(local, options.deleteData.totalBytes)
            : { freed: 0, failed: [] };
          const purgeFailed = purged.failed.map(({ row }) => row);
          // 移除失败的横幅优先，它的重试在同一批里连同这些数据删除失败的项目一起重跑。
          if (failed.length)
            fail(
              "remove",
              failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
              () =>
                remove(
                  failed.map(({ row }) => row),
                  { deleteData: {} },
                  purgeFailed,
                ),
            );
          else
            fail(
              "purge",
              purged.failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
              () => purge(purgeFailed),
            );
          if (!removed.length) return;
          // 不带撤销：本机项目数据已删除，只撤销项目行会误导。
          return () =>
            resultToast(
              formatCountMessage(intl, "projectManagement.data.removedToast", removed.length, {
                size: formatBytes(purged.freed),
              }),
            );
        }
        fail(
          "remove",
          failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
          () => remove(failed.map(({ row }) => row)),
        );
        if (!removed.length) return;
        return () =>
          resultToast(formatCountMessage(intl, "projectManagement.removedToast", removed.length), {
            actionLabel: intl.formatMessage({ id: "projectManagement.undo" }),
            onAction: () => void undoRef.current(removed),
          });
      }),
    [exclusive, fail, intl, purge, purgeRows, resultToast, service],
  );

  const undo = useCallback(
    (removed: readonly RemovedProject[]) =>
      exclusive(async () => {
        const failed: { item: RemovedProject; cause: unknown }[] = [];
        let restored = 0;
        for (const item of removed) {
          try {
            if (!service) throw new Error("project.service-unavailable");
            await service.restoreProject(item.row.project.id, item.row.project.hostId);
            restored++;
          } catch (cause) {
            failed.push({ item, cause });
            logger.error("[project-management] 撤销移除失败", {
              projectId: item.row.project.id,
              hostId: item.row.project.hostId,
              cause,
            });
          }
        }
        if (restored)
          resultToast(formatCountMessage(intl, "projectManagement.restoredToast", restored));
        fail(
          "undo",
          failed.map(({ item, cause }) => ({ name: item.row.project.name, cause })),
          () => undoRef.current(failed.map(({ item }) => item)),
        );
      }),
    [exclusive, fail, intl, resultToast, service],
  );
  undoRef.current = undo;

  const restore = useCallback(
    (project: VirtualProject) =>
      exclusive(async () => {
        try {
          if (!service) throw new Error("project.service-unavailable");
          await service.restoreProject(project.id, project.hostId);
          resultToast(intl.formatMessage({ id: "projectManagement.restoredToastOne" }));
        } catch (cause) {
          logger.error("[project-management] 恢复项目失败", { projectId: project.id, cause });
          fail("restore", [{ name: project.name, cause }], () => restoreRef.current(project));
        }
      }),
    [exclusive, fail, intl, resultToast, service],
  );
  restoreRef.current = restore;

  return {
    supported: Boolean(service),
    busy,
    failure,
    remove,
    restore,
    measureData,
    dismissFailure: () => setFailure(null),
  };
}
