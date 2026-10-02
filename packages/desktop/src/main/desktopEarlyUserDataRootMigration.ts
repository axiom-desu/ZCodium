import { getDataBaseDir } from "@zcode/services/node";
import { migrateLegacyUserDataRoot } from "@zcode/shared/node";
import { logger } from "./logger.js";

/**
 * 启动早期把旧用户级数据根搬到新根。
 *
 * Bugfix：用户级数据根从 `.zcodium` 让位给 `.zcodium-exp`（ZCodium-project/ZCodium 的
 * #13/#17 正把 `~/.zcodium` 收敛为它们的数据根，两个产品不能共用同一棵树）。
 * 常量改名后新构建只读新根，若不在这里搬一次，存量用户的凭据、配置、会话、日志
 * 会全部留在旧根，表现为升级后要重新登录、机器人绑定丢失、历史会话消失。
 *
 * 必须在 desktopEarlyDataBaseDirBootstrap **之后**执行：那个模块会用旧根里的
 * dataBaseDir 调 setDataBaseDir，之后的 getDataBaseDir() 才是用户真实的基目录。
 * 顺序反了的话，自定义数据目录的用户会被按默认 HOME 迁移，数据搬错地方。
 *
 * 也必须在 desktopEarlyChromiumHardwareAccelerationBootstrap 之前或之后都无所谓——
 * 那个模块已改为「新根优先、旧根回落」，两种时序都读得到。
 *
 * 迁移失败不抛异常：启动阶段抛出会让整个进程起不来，比数据没搬严重得多。
 */
migrateLegacyUserDataRootEarly();

function migrateLegacyUserDataRootEarly(): void {
  try {
    const result = migrateLegacyUserDataRoot({ baseDir: getDataBaseDir() });
    switch (result.status) {
      case "migrated":
        logger.info("[runtime] 用户级数据根已迁移到新命名空间", {
          legacyRoot: result.legacyRoot,
          nextRoot: result.nextRoot,
        });
        return;
      case "skipped-both-exist":
        logger.warn("[runtime] 新旧用户级数据根同时存在，跳过迁移", {
          legacyRoot: result.legacyRoot,
          nextRoot: result.nextRoot,
        });
        return;
      case "failed":
        logger.warn("[runtime] 用户级数据根迁移失败，保留旧目录", {
          legacyRoot: result.legacyRoot,
          nextRoot: result.nextRoot,
          error: result.error,
        });
        return;
      default:
        return;
    }
  } catch (error) {
    logger.warn("[runtime] 用户级数据根迁移前置解析失败", { error });
  }
}
