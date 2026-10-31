import { useEffect, useMemo, useRef, useState } from "react";
import type { VirtualProject } from "@zcode/services";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  configHostIdForSource,
  configSourceOnline,
  deriveConfigDirectoryTargets,
  deriveSourceConnectionKeys,
} from "@/lib/configDirectoryCatalog.js";
import {
  invalidateAllSourceSettingsServices,
  reconcileSourceSettingsConnections,
} from "@/store/sourceSettingsServiceStore.js";
import { logger } from "@/logger.js";

/** 仅派生本次 Settings 的元数据视图；无存库、任务读取或 attachment admission。 */
export function useConfigDirectoryCatalog() {
  const services = useBaseWorkspaceServices();
  const projectService = services.projectService;
  const { snapshot, ready } = useSourceServerManagementSnapshot();
  const currentSnapshot = ready ? snapshot : null;
  const tabs = useTabStore((state) => state.tabs);
  const [read, setRead] = useState<{
    service: typeof projectService;
    snapshot: SourceServerManagementSnapshot | null;
    projects: VirtualProject[];
    readyHosts: string[];
  } | null>(null);

  // Source settings proxy 属于当前 Host/Source 连接：owner 被替换后旧 proxy 全部失效。
  const servicesOwnerRef = useRef(services);
  useEffect(() => {
    if (servicesOwnerRef.current === services) return;
    servicesOwnerRef.current = services;
    invalidateAllSourceSettingsServices();
  }, [services]);

  // 断线、重连换代或 Source 消失都推进连接代际；旧代理立即失效，不靠超时。
  useEffect(() => {
    if (!currentSnapshot) return;
    reconcileSourceSettingsConnections(deriveSourceConnectionKeys(currentSnapshot));
  }, [currentSnapshot]);

  useEffect(() => {
    let disposed = false;
    const hosts = [
      "local",
      ...(currentSnapshot?.servers ?? [])
        .filter((server) => configSourceOnline(currentSnapshot, server.sourceServerId))
        .map((server) => configHostIdForSource(server.sourceServerId)),
    ];
    void Promise.all(
      hosts.map(async (hostId) => {
        try {
          if (!projectService) return { projects: [], hostId: hostId === "local" ? hostId : null };
          const projects = await projectService.readProjects(hostId === "local" ? {} : { hostId });
          // 远端读到的 local 是该 Host 自身；控制端归属必须来自本次可信路由，不能伪装本机。
          return { projects: projects.map((project) => ({ ...project, hostId })), hostId };
        } catch (error) {
          logger.warn("[config-directory] 读取项目目录失败", { hostId, error });
          return { projects: [], hostId: null };
        }
      }),
    ).then((results) => {
      // service/Source 换代或卸载后晚到的 A 不得发布到 B。
      if (disposed) return;
      setRead({
        service: projectService,
        snapshot: currentSnapshot,
        projects: results.flatMap((result) => result.projects),
        readyHosts: results.flatMap((result) => (result.hostId ? [result.hostId] : [])),
      });
    });
    return () => {
      disposed = true;
    };
  }, [currentSnapshot, projectService]);

  return useMemo(() => {
    const current = read?.service === projectService && read?.snapshot === currentSnapshot;
    return deriveConfigDirectoryTargets({
      projects: read?.projects ?? [],
      snapshot: currentSnapshot,
      tabs: tabs.filter(isWorkspaceTab),
      readyHosts: current ? read.readyHosts : [],
    });
  }, [currentSnapshot, projectService, read, tabs]);
}
