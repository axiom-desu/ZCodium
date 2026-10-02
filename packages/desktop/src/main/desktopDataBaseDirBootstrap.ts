import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { LEGACY_ZCODE_USER_DATA_DIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  // 数据根换名后首次启动，用户配置的 dataBaseDir 还在旧根里；若这里只认新根，
  // 读不到配置就会按默认 HOME 继续启动，随后迁移会搬到错误的基目录下。
  // 因此新根优先、缺失时回落旧根，等一次性迁移把树搬到新根后自然走到新根。
  const nextRoot = join(homePath, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
  if (existsSync(nextRoot)) {
    return nextRoot;
  }
  return join(homePath, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
