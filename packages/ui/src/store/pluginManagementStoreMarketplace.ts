import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";
import {
  beginPluginOperation,
  runWorkspaceOperation,
} from "@/store/pluginManagementStoreLoading.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SetState = (partial: Partial<PluginManagementState>) => void;
type GetState = () => PluginManagementState;

/** 市场源写操作；与插件安装共用同一 operation 失效/快照刷新边界。 */
export function createMarketplaceActions(set: SetState, get: GetState) {
  return {
    async addMarketplace(source: string, pluginService: IPluginManagementService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:add:${source}`,
        async (workspace) => {
          await pluginService.addPluginMarketplace({ ...workspace, source });
        },
      );
    },

    async updateMarketplace(marketplace: string | null, pluginService: IPluginManagementService) {
      let refreshError: string | null = null;
      const succeeded = await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:update:${marketplace ?? "__all__"}`,
        async (workspace) => {
          const result = await pluginService.updatePluginMarketplace({
            ...workspace,
            ...(marketplace ? { marketplace } : {}),
          });
          // 刷新允许部分成功，因此仍要 reload overview 保留成功来源；但仅 warn
          // 并返回 true，桌面与手机 Web 都会把旧快照误报成刷新成功。先记住错误，reload 后再写入
          // 共用 store 的可见错误态，同时返回 false，让所有入口获得一致的部分失败语义。
          const blockingDiagnostic = result.diagnostics?.find(
            (diagnostic) => diagnostic.severity === "error",
          );
          if (blockingDiagnostic) {
            refreshError = blockingDiagnostic.message;
            logger.warn("[plugins] marketplace refresh partially failed", {
              diagnostics: result.diagnostics,
            });
          }
        },
      );
      if (succeeded && refreshError) {
        set({ error: refreshError, lastFailedPluginId: null });
        return false;
      }
      return succeeded;
    },

    async removeMarketplace(marketplace: string, pluginService: IPluginManagementService) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:remove:${marketplace}`,
        async (workspace) => {
          await pluginService.removePluginMarketplace({ ...workspace, marketplace });
        },
      );
    },

    async validateSource(source: string, pluginService: IPluginManagementService) {
      const { workspacePath, workspaceIdentity } = get();
      if (!workspacePath) return;
      const finish = beginPluginOperation(set, get, `marketplace:validate:${source}`);
      const version = get().operationVersion;
      try {
        const result = await pluginService.validatePlugin({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          source,
        });
        if (get().operationVersion === version) set({ diagnostics: result.diagnostics });
      } catch (error) {
        logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
        if (get().operationVersion === version) {
          set({ error: toMessage(error), lastFailedPluginId: null });
        }
      } finally {
        finish();
      }
    },
  };
}
