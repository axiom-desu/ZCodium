import type { DataSyncImportResultItem, PluginDataSyncPayload } from "@zcode/shared";
import type { IDataSyncCategoryService, IServiceAccessor } from "@zcode/services";
import {
  createMarketplacePluginDataSyncService,
  type DataSyncPushControl,
  type MarketplacePluginSyncPayload,
} from "./marketplacePluginSync.js";

export type { DataSyncPushControl };

/** 插件分类的组合 payload：inline 插件走 pluginSyncService，marketplace 插件走 Agent 编排。 */
interface PluginCategorySyncPayload {
  inline?: PluginDataSyncPayload;
  marketplace?: MarketplacePluginSyncPayload;
}

const INLINE_KEY_SUFFIX = "@inline";

function isInlineKey(key: string): boolean {
  return key.endsWith(INLINE_KEY_SUFFIX);
}

/** 插件分类 = inline 插件（pluginSyncService）+ marketplace 插件（Agent 编排），按 key 后缀分派。 */
export function createPluginCategoryDataSyncService(
  services: IServiceAccessor,
  control?: DataSyncPushControl,
): IDataSyncCategoryService<PluginCategorySyncPayload> {
  const inline = services.pluginSyncService;
  const marketplace = createMarketplacePluginDataSyncService(services, control);
  return {
    async listSyncItems() {
      const [inlineList, marketplaceList] = await Promise.all([
        inline.listSyncItems(),
        marketplace.listSyncItems(),
      ]);
      return {
        items: [...inlineList.items, ...marketplaceList.items],
        homeDir: inlineList.homeDir,
      };
    },
    // marketplace 条目只按版本比较，不会被请求哈希。
    getSyncContentHashes: (params) => inline.getSyncContentHashes(params),
    checkSyncWriteAccess: () => inline.checkSyncWriteAccess(),
    async exportSyncItems({ keys }) {
      const inlineKeys = keys.filter(isInlineKey);
      const marketplaceKeys = keys.filter((key) => !isInlineKey(key));
      const [inlinePayload, marketplacePayload] = await Promise.all([
        inlineKeys.length > 0 ? inline.exportSyncItems({ keys: inlineKeys }) : undefined,
        marketplaceKeys.length > 0
          ? marketplace.exportSyncItems({ keys: marketplaceKeys })
          : undefined,
      ]);
      return {
        ...(inlinePayload ? { inline: inlinePayload } : {}),
        ...(marketplacePayload ? { marketplace: marketplacePayload } : {}),
      };
    },
    async importSyncItems({ payload, items }) {
      const results: DataSyncImportResultItem[] = [];
      const inlineItems = items.filter((item) => isInlineKey(item.key));
      const marketplaceItems = items.filter((item) => !isInlineKey(item.key));
      if (payload.inline && inlineItems.length > 0) {
        // inline 插件按批导入；整批失败时抛出，由推送 owner 把该批各项记为失败。
        const imported = await inline.importSyncItems({
          payload: payload.inline,
          items: inlineItems,
        });
        results.push(...imported.results);
      }
      if (payload.marketplace && marketplaceItems.length > 0) {
        results.push(
          ...(
            await marketplace.importSyncItems({
              payload: payload.marketplace,
              items: marketplaceItems,
            })
          ).results,
        );
      }
      return { results };
    },
  };
}
