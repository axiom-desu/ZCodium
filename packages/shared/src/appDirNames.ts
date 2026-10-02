/**
 * ZCodium 落盘命名空间的唯一来源。
 *
 * ZCodium 与 ZCode 是独立软件，不共用数据目录：这里从 `.zcodium*` 改为 `.zcodium*`，
 * 且不做旧目录迁移（见 .agents/specs/zcodium-data-dir.md）。新增目录或文件名时必须
 * 引用这些常量，不要在业务代码里散落字面量，否则改名会再次漏改。
 */

/**
 * 用户级数据根目录名，默认 `~/.zcodium-exp`（可被 ZCODE_DATA_BASE_DIR 改写基路径）。
 *
 * Bugfix：ZCodium-project/ZCodium 的 #13/#17 正把用户级数据根收敛到 `~/.zcodium`，
 * 与本仓库自 f12f4ea 起持有的 `~/.zcodium` 必然相撞（两个产品会读写彼此的凭据、
 * 配置与会话）。本仓库让出 `~/.zcodium`，改占 `~/.zcodium-exp`；
 * 旧根名见 LEGACY_ZCODE_USER_DATA_DIR_NAME，仅用于一次性迁移。
 */
export const ZCODE_USER_DATA_DIR_NAME = ".zcodium-exp";

/** 换名前用户级数据根目录名，仅用于一次性迁移，不再作为读写目标。 */
export const LEGACY_ZCODE_USER_DATA_DIR_NAME = ".zcodium";

/** 迁移成功后写在旧根内的标记文件，防止下次启动重复灌入。 */
export const ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME = ".migrated-to-zcodium-exp";

/** 用户级 App 配置子目录名，即 `~/.zcodium/v2`。 */
export const ZCODE_APP_CONFIG_SUBDIR_NAME = "v2";

/** 工作区级配置目录名，即 `<workspace>/.zcodium`。 */
export const ZCODE_WORKSPACE_CONFIG_DIR_NAME = ".zcodium";

/** 工作区级 hooks 配置文件名（与 `.zcodium/config.json` 并存的一种形态）。 */
export const ZCODE_WORKSPACE_CONFIG_FILE_NAME = "zcodium.json";

/** 工作区文件搜索忽略规则文件名。 */
export const ZCODE_WORKSPACE_IGNORE_FILE_NAME = ".zcodiumignore";

/** 插件清单目录名，即 `<plugin>/.zcodium-plugin/plugin.json`。 */
export const ZCODE_PLUGIN_MANIFEST_DIR_NAME = ".zcodium-plugin";

/** 插件清单文件名。 */
export const ZCODE_PLUGIN_MANIFEST_FILE_NAME = "plugin.json";
