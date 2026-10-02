import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LEGACY_ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME,
} from "../appDirNames.js";

export interface MigrateLegacyUserDataRootOptions {
  /**
   * 数据根基目录：迁移在其下寻找旧根与新根。
   * 调用方传各自环境的权威值（桌面是 setDataBaseDir 之后的 getDataBaseDir()，
   * CLI / server 是 ZCODE_DATA_BASE_DIR 或 homedir()）。
   * 这里不自己读环境变量：baseDir 的判定优先级属于调用方，迁移不该绕过它。
   */
  baseDir: string;
}

export type MigrateLegacyUserDataRootResult =
  | { status: "migrated"; legacyRoot: string; nextRoot: string }
  | { status: "noop-no-legacy" }
  | { status: "noop-already-migrated"; legacyRoot: string }
  | { status: "skipped-both-exist"; legacyRoot: string; nextRoot: string }
  | { status: "failed"; legacyRoot: string; nextRoot: string; error: unknown };

/**
 * 把换名前的用户级数据根整体搬到新根，只搬一次。
 *
 * Bugfix：ZCodium-project/ZCodium 的 #13/#17 把用户级数据根收敛到 `~/.zcodium`，
 * 与本仓库的 `~/.zcodium` 相撞。常量改名后新构建读 `~/.zcodium-exp`，若不做迁移，
 * 存量用户的凭据 / 配置 / 会话 / 日志会全部落在旧根里，表现为「升级后要重新登录、
 * 机器人绑定丢失、历史会话消失」。这里的搬运让数据跟着身份一起走。
 *
 * 与对方 #13 的差异：对方用「复制」是因为必须保留 `~/.zcode` 给官方 ZCode 客户端继续用；
 * 本仓库的旧根 `~/.zcodium` 是自己的数据、没有第三方读者，但仍选择**复制 + 标记**
 * 而不是移动——复制失败时旧根完好无损，不会把用户数据置于「搬一半」的风险里。
 *
 * 三个不变量：
 * 1. **不覆盖**：新根已存在时保留现状并返回 skipped-both-exist，绝不向任一方向合并或删除；
 * 2. **不重复灌入**：成功后旧根写标记文件，后续启动直接 noop；
 * 3. **不阻断启动**：任何 IO 失败只返回 failed，由调用方记日志，不进抛出路径——
 *    启动阶段抛异常会让整个进程起不来，比数据没搬严重得多。
 *
 * 复制落在新根同卷的临时目录再 rename，保证跨设备时也能完成，且 rename 是同卷原子操作，
 * 并发启动的两个进程不会看到半棵树。
 */
export function migrateLegacyUserDataRoot(
  options: MigrateLegacyUserDataRootOptions,
): MigrateLegacyUserDataRootResult {
  const baseDir = options.baseDir.trim();
  const legacyRoot = join(baseDir, LEGACY_ZCODE_USER_DATA_DIR_NAME);
  const nextRoot = join(baseDir, ZCODE_USER_DATA_DIR_NAME);

  if (legacyRoot === nextRoot || !existsSync(legacyRoot)) {
    return { status: "noop-no-legacy" };
  }
  if (existsSync(join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME))) {
    return { status: "noop-already-migrated", legacyRoot };
  }
  if (existsSync(nextRoot)) {
    // 两边都在：可能是用户已经手动搬过，或新旧构建交替运行过。保留现状，
    // 让用户或运维决定，程序不做任何合并猜测。
    return { status: "skipped-both-exist", legacyRoot, nextRoot };
  }

  const stagingRoot = join(dirname(nextRoot), `.${basename(nextRoot)}.migrating-${randomUUID()}`);
  try {
    // 临时目录必须与新根同卷，否则 renameSync 会 EXDEV。
    mkdirSync(dirname(nextRoot), { recursive: true });
    cpSync(legacyRoot, stagingRoot, { recursive: true });
    renameSync(stagingRoot, nextRoot);
    // 标记写在旧根里且仅在新根落位之后：写标记前崩溃，下次启动会重试；
    // 写标记后崩溃，旧根仍在但已判定迁移完成，不会二次灌入。
    writeFileSync(
      join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME),
      `${JSON.stringify({ migratedTo: nextRoot, at: new Date().toISOString() })}\n`,
      "utf8",
    );
    return { status: "migrated", legacyRoot, nextRoot };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    return { status: "failed", legacyRoot, nextRoot, error };
  }
}
