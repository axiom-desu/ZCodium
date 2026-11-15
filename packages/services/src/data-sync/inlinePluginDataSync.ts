import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  pickPortablePluginOptions,
  type DataSyncListItem,
  type PluginDataSyncPayload,
} from "@zcode/shared";
import {
  createPluginSyncArchive,
  type PluginSyncArchiveMetadata,
} from "#src/plugin-sync/pluginSyncArchive.js";
import {
  createShortHash,
  getUserZcodeConfigPath,
  getUserZcodePluginRoot,
  resolveUserHomeDir,
  toSafeDirectoryName,
} from "#src/plugin-sync/pluginSyncService.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { hashDirectoryContent, scanDirectoryContent } from "./directoryContent.js";
import { importInlinePluginSyncItems } from "./inlinePluginDataSyncImport.js";
import {
  INLINE_PLUGIN_CONTENT_OPTIONS,
  PLUGIN_DATA_DIRECTORY,
  resolveInlinePlugins,
  type ResolvedInlinePlugin,
} from "./inlinePluginDataSyncShared.js";

export function createInlinePluginDataSyncMethods(options: {
  maxItemBytes: number;
}): IDataSyncCategoryService<PluginDataSyncPayload> {
  const { maxItemBytes } = options;

  async function listItem(plugin: ResolvedInlinePlugin): Promise<DataSyncListItem> {
    const scan = await scanDirectoryContent(plugin.contentRoot, INLINE_PLUGIN_CONTENT_OPTIONS);
    return {
      key: plugin.key,
      name: plugin.manifest.name,
      pluginId: plugin.manifest.pluginId,
      ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
      signature: { fileCount: scan.fileCount, totalBytes: scan.totalBytes },
      enabled: plugin.enabled,
      ...(scan.totalBytes > maxItemBytes
        ? { exportBlockedReason: "size-limit" as const }
        : scan.containsSymlink
          ? { exportBlockedReason: "contains-symlink" as const }
          : {}),
      ...(plugin.overwriteBlockedReason
        ? { overwriteBlockedReason: plugin.overwriteBlockedReason }
        : {}),
    };
  }

  /** 超限项不计算哈希（列表只给签名，哈希按需）。 */
  async function hashPlugin(plugin: ResolvedInlinePlugin): Promise<string | undefined> {
    const scan = await scanDirectoryContent(plugin.contentRoot, INLINE_PLUGIN_CONTENT_OPTIONS);
    return scan.totalBytes > maxItemBytes
      ? undefined
      : await hashDirectoryContent(plugin.contentRoot, INLINE_PLUGIN_CONTENT_OPTIONS);
  }

  return {
    async listSyncItems() {
      const plugins = await resolveInlinePlugins();
      return {
        items: await Promise.all([...plugins.values()].map((plugin) => listItem(plugin))),
        homeDir: resolveUserHomeDir(),
      };
    },

    async getSyncContentHashes(params) {
      const plugins = await resolveInlinePlugins();
      const hashes: Record<string, string> = {};
      await Promise.all(
        params.keys.map(async (key) => {
          const plugin = plugins.get(key);
          const hash = plugin ? await hashPlugin(plugin) : undefined;
          if (hash) hashes[key] = hash;
        }),
      );
      return { hashes };
    },

    async checkSyncWriteAccess() {
      // 新建要写插件目录和 config.json 的 plugins.dirs。
      return await checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodePluginRoot(),
        dirname(getUserZcodeConfigPath()),
      ]);
    },

    async exportSyncItems(params) {
      const plugins = await resolveInlinePlugins();
      const usedDirectoryNames = new Set<string>();
      const selected = await Promise.all(
        params.keys.map(async (key) => {
          const plugin = plugins.get(key);
          if (!plugin) throw new Error(`plugin sync item not found: ${key}`);
          const scan = await scanDirectoryContent(
            plugin.contentRoot,
            INLINE_PLUGIN_CONTENT_OPTIONS,
          );
          if (scan.totalBytes > maxItemBytes) {
            throw new Error(`plugin exceeds the size limit: ${scan.totalBytes}/${maxItemBytes}`);
          }
          if (scan.containsSymlink) throw new Error(`plugin contains a symbolic link: ${key}`);
          return plugin;
        }),
      );
      const items = selected.map((plugin) => {
        let directoryName = toSafeDirectoryName(
          basename(plugin.contentRoot) || plugin.manifest.name,
        );
        if (usedDirectoryNames.has(directoryName)) {
          directoryName = toSafeDirectoryName(
            `${directoryName}-${createShortHash(plugin.contentRoot).slice(0, 8)}`,
          );
        }
        usedDirectoryNames.add(directoryName);
        return { plugin, directoryName };
      });
      // 逐个顶层条目打包，跳过 data/。
      const entries = (
        await Promise.all(
          items.map(async ({ plugin, directoryName }) =>
            (await readdir(plugin.contentRoot))
              .filter((name) => name !== PLUGIN_DATA_DIRECTORY)
              .map((name) => ({
                sourcePath: join(plugin.contentRoot, name),
                archivePath: `${directoryName}/${name}`,
              })),
          ),
        )
      ).flat();
      const metadata: PluginSyncArchiveMetadata = {
        plugins: items.map(({ plugin, directoryName }) => ({
          name: plugin.manifest.name,
          pluginId: plugin.manifest.pluginId,
          directoryName,
        })),
      };
      const archive = await createPluginSyncArchive({ entries, metadata });
      if (archive.byteLength > maxItemBytes) {
        throw new Error(`plugin sync archive exceeds limit: ${archive.byteLength}/${maxItemBytes}`);
      }
      return {
        archive,
        sourceHomeDir: resolveUserHomeDir(),
        items: items.map(({ plugin, directoryName }) => ({
          key: plugin.key,
          pluginId: plugin.manifest.pluginId,
          directoryName,
          enabled: plugin.enabled,
          options: pickPortablePluginOptions(plugin.options, plugin.manifest.userConfig),
        })),
      };
    },

    async importSyncItems(params) {
      return await importInlinePluginSyncItems({
        payload: params.payload,
        items: params.items,
        maxItemBytes,
      });
    },
  };
}
