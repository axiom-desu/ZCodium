import { access, open, readFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppSettings } from "@zcode/shared";
import {
  ZCODE_USER_DATA_DIR_NAME,
  appSettingsPatchSchema,
  appSettingsSchema,
  formatLogPrefix,
  formatZodError,
  hasLegacyIncompatiblePersistedLocale,
  toPersistedSettingsLocaleFields,
  USER_INSTRUCTIONS_MAX_BYTES,
  USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import type { ISettingService, UserInstructionsSnapshot } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import {
  copyDataDirectory,
  getAgentUserInstructionsFilePath,
  getDataBaseDir,
  validateDataBaseDirTarget,
} from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import { getErrorCode } from "./getErrorCode.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
} from "#src/setting/legacyAccountConnectionSettings.js";
const MAX_RECENT_PROJECTS = 10;
const DEFAULT_PROJECT_NAME = "ZCodeProject";
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
const debugLog = (...args: unknown[]) => {
  // NODE_ENV 来自用户 shell 时会误导服务层 debug 开关；统一使用 ZCODE_RUNTIME_ENV。
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

/**
 * 有界读取用户指令：最多 `USER_INSTRUCTIONS_MAX_BYTES`，TC 结尾不保留半个 UTF-8 字符。
 * 读取上限是安全边界（W5），不能在 UI 或调用方依赖“先读全量再切片”。
 */
async function readUserInstructionsBounded(
  filePath: string,
): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, USER_INSTRUCTIONS_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const truncated = info.size > USER_INSTRUCTIONS_MAX_BYTES;
    const content = buffer.subarray(0, offset).toString("utf8");
    return { content: truncated ? content.replace(/\uFFFD$/u, "") : content, truncated };
  } finally {
    await handle.close();
  }
}

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getSettingsDir() {
  return join(resolveUserHomeDir(), ZCODE_USER_DATA_DIR_NAME, "v2");
}

function getSettingsFile() {
  return join(getSettingsDir(), "setting.json");
}

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // 用户手动编辑或远端磁盘异常可能把 setting.json 写成非 JSON（例如 ":wq"）。
    // 如果只返回默认值不隔离坏文件，每次启动都会重复解析失败；这里保留备份后让后续 update 重建合法配置。
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 启动时多个服务可能同时读取同一个坏 setting.json。
      // 第一个读取已经完成隔离后，后续读取再 rename 会遇到 ENOENT；这是并发下的预期结果，不应当按备份失败刷错误日志。
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true ||
    // 自动归档重置迁移：首读在内存里关掉旧开关后必须落盘，否则用户重新开启后
    // 下一次启动又会因为磁盘上仍缺标记而再关一次。
    raw.taskAutoArchiveResetVersion !== 1 ||
    hasLegacyIncompatiblePersistedLocale(raw)
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

async function readSettingsWithMeta(): Promise<ReadSettingsResult> {
  const settingsFile = getSettingsFile();
  try {
    // settingService.get() 会被 UI 和远程会话高频调用。
    // 之前每次读取都把完整配置写入生产日志，导致日志暴涨且暴露路径/配置细节；普通读取只保留开发态 debug。
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // setting.json 可能正被另一次 update 覆盖写入，读者会短暂读到半截 JSON。
      // 先做短重试，只有连续失败才按坏文件隔离，避免把正常会话配置误清成默认值。
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    debugLog("read result:", JSON.stringify(result.data));
    return {
      settings: result.data,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // 文件解析失败等异常兜底返回默认值
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

async function readSettings(): Promise<AppSettings> {
  return (await readSettingsWithMeta()).settings;
}

async function writeSettings(
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  runExclusiveCommit: (commit: () => Promise<void>) => Promise<void> = (commit) => commit(),
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
): Promise<void> {
  const settingsDir = getSettingsDir();
  const settingsFile = getSettingsFile();
  // Windows 下测试只改了 HOME，模块顶层常量如果在导入时就把 homedir() 固化，
  // 后续读写仍会串到真实用户目录。这里改成每次按当前环境解析配置路径，保证本地和测试都稳定。
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  const persisted = {
    ...rollbackFields,
    ...settings,
    ...toPersistedSettingsLocaleFields(settings),
  };
  // 旧 Team 缺少组织信息，schema 的默认 {} 不是用户的新选择。
  // 联网补全已移除；普通偏好保存仍保留原字段，不伪造或覆盖历史连接。
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    // 调用方 withFileLock 已持有 setting.json 的跨进程锁，这里再加锁会自我等待到超时。
    useFileLock: false,
    beforeRename: () => {
      if (!shouldCommit()) {
        // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
    runRename: (renameFile) =>
      runExclusiveCommit(async () => {
        if (!shouldCommit()) throw new Error("stale settings write skipped before atomic rename");
        await renameFile();
      }),
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  let updateQueue = Promise.resolve();
  let commitQueue = Promise.resolve();
  let writeQueueGeneration = 0;
  // 用户指令写入串行：保存后立即重新读取不能读到旧内容；跨进程互斥由 atomicWriteText 的同目录锁负责，本队列只排同实例内读写。
  let userInstructionsWriteQueue = Promise.resolve();

  const enqueueUserInstructionsWrite = async (run: () => Promise<void>): Promise<void> => {
    const queued = userInstructionsWriteQueue.then(run, run);
    userInstructionsWriteQueue = queued.catch(() => {});
    await queued;
  };

  const runSettingsCommit = async (commit: () => Promise<void>) => {
    const queued = commitQueue.then(commit, commit);
    commitQueue = queued.catch(() => {});
    await queued;
  };

  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = () => {
      const currentGeneration = ++writeQueueGeneration;
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      // Bug 原因：Main 与各窗口 Host 各有一个 setting service，原先的跨进程锁只覆盖临时文件写入和
      // rename，两个进程会各自读到旧快照再整文件写回，后写的一方抹掉前者刚保存的字段。
      // 修复依据：与 credentialService 相同，让跨进程锁覆盖读取、合并和原子替换的全过程。
      // 进程内仍走原有 updateQueue 串行，锁只负责跨进程。
      return withFileLock(getSettingsFile(), () =>
        withSettingsWriteQueueTimeout(
          (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
          () => {
            if (writeQueueGeneration === currentGeneration) {
              writeQueueGeneration += 1;
            }
          },
        ),
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
    updateQueue = queued.catch(() => {});
    await queued;
  };

  const service: ISettingService = {
    async get(): Promise<AppSettings> {
      // 设置切换后可能立即创建或冷恢复 Session；读取若越过已入队写入，runtime 会固定旧开关值，因此等待现有写队列读取已提交选择。
      await updateQueue;
      const result = await readSettingsWithMeta();
      if (!result.needsMigrationPersist) {
        return result.settings;
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta();
        if (!latest.needsMigrationPersist) {
          return;
        }

        // 初始化原因：旧版设置可能已把无法区分来源的默认值落盘；升级后按 schema 统一迁移一次。
        // 迁移写盘必须进入 updateQueue，并在队列内重读最新文件，避免覆盖并发保存的其他设置。
        await writeSettings(latest.settings, shouldCommit, runSettingsCommit, enterCommitPhase);
      });

      return readSettings();
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const current = await readSettings();
        if (expectedAccountSettings) {
          // 账号查询期间用户可能已手动切换。必须在同一写队列内校验，不能靠调用方先读再写。
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({
          ...current,
          ...validatedPatch,
        });

        // 打开工作区后会几乎同时写 recentProjects 和 lastWorkspaceSession。
        // 之前两个 update 都是基于各自读到的旧 settings 直接覆盖写回，
        // 后写入的补丁会把前一个字段整块抹掉，导致下次启动恢复不到会话。
        // 这里把写入串行化，让每个补丁都基于上一次真正落盘后的最新状态继续合并。
        if (merged.recentProjects) {
          merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
        }

        await writeSettings(
          merged,
          shouldCommit,
          runSettingsCommit,
          enterCommitPhase,
          Object.hasOwn(patch, "providerFamilyConnectionSelections"),
        );
      };

      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器/自动更新管理，把 .zcodium/v2 放进去可能在升级时被覆盖。
        // 迁移前在 service 层拦截，避免 UI 入口变化或 RPC 调用绕过前端判断。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },

    async getUserInstructions(): Promise<UserInstructionsSnapshot> {
      // 读取等待已接纳的写入排空：保存后立即重进分区时不能把旧内容当基线。
      await userInstructionsWriteQueue;
      const filePath = getAgentUserInstructionsFilePath();
      try {
        // Bug 原因：旧实现 readFile 整份读入，超大文件会把内存/网络打满；且截断草稿保存后
        // 会静默丢掉后半段。修复依据见安全 spec（W5）：只读前 100KiB 并标记 truncated，
        // UI 据此禁用保存；UTF-8 末尾不保留半个字符。
        const bounded = await readUserInstructionsBounded(filePath);
        return {
          content: bounded.content,
          filePath,
          ...(bounded.truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          // 文件不存在等价于未配置个性化指令：不报错，也不创建文件。
          return { content: "", filePath };
        }
        throw error;
      }
    },

    async saveUserInstructions(content: string): Promise<{ filePath: string }> {
      // 最终校验用与 CLI 读取一致的共享常量，防止其他 RPC 调用方绕过 UI 写入超限内容
      // （Agent 只读前 100KB，超限保存会让用户误以为全部生效）。
      if (Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES) {
        const error = new Error(`user instructions exceed ${USER_INSTRUCTIONS_MAX_BYTES} bytes`);
        (error as Error & { code: string }).code = USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE;
        throw error;
      }
      const filePath = getAgentUserInstructionsFilePath();
      await enqueueUserInstructionsWrite(async () => {
        // 复用共享的私有文本原子写入（临时文件固定 0600，rename 不会把已有 0600 放宽），
        // withFileLock 先建目录再取同目录跨进程锁，多个窗口/Host 会串行覆盖同一个文件。
        await withFileLock(filePath, async () => {
          // Bug 原因：超大文件被有界读取成截断草稿后，直接保存会覆盖完整文件、静默丢掉后半段。
          // 修复依据见安全 spec（W5）：在写锁内再次确认现有文件未超限，拒绝覆盖超限基线。
          const currentSize = await stat(filePath).then(
            (info) => info.size,
            (error: unknown) => {
              if (getErrorCode(error) === "ENOENT") return 0;
              throw error;
            },
          );
          if (currentSize > USER_INSTRUCTIONS_MAX_BYTES) {
            const error = new Error(
              `refusing to overwrite user instructions larger than ${USER_INSTRUCTIONS_MAX_BYTES} bytes`,
            );
            (error as Error & { code: string }).code = USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE;
            throw error;
          }
          await atomicWritePrivateTextFile(filePath, content);
        });
      });
      return { filePath };
    },

    async ensureDefaultProject(userHomeDir: string): Promise<{ path: string; created: boolean }> {
      const path = join(userHomeDir, DEFAULT_PROJECT_NAME);
      let existedBefore = true;

      try {
        await access(path).catch(() => {
          existedBefore = false;
        });
        maybeThrowInjectedFsFault({ operation: "mkdir", path });
        await mkdir(path, { recursive: true });
      } catch (error) {
        log("ensureDefaultProject failed:", error);
        throw error;
      }

      return { path, created: !existedBefore };
    },
  };

  return service;
}
