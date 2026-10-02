import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_ZCODE_USER_DATA_DIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
}

function resolveChromiumHardwareAccelerationSettingsFile(homePath: string = homedir()): string {
  // 与 desktopDataBaseDirBootstrap 同理：换名后的首次启动必须能从旧根读到
  // 硬件加速开关，否则迁移发生前会用默认值创建 Chromium 实例。
  const nextRoot = join(homePath, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
  if (existsSync(nextRoot)) {
    return nextRoot;
  }
  return join(homePath, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
}

function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return true;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function readBootstrapChromiumHardwareAccelerationEnabledFromDisk(
  settingsFile: string = resolveChromiumHardwareAccelerationSettingsFile(),
): boolean {
  if (!existsSync(settingsFile)) {
    return true;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapChromiumHardwareAccelerationEnabled(JSON.parse(raw));
  } catch {
    return true;
  }
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  const enabled =
    rawSettings === undefined
      ? readBootstrapChromiumHardwareAccelerationEnabledFromDisk()
      : extractBootstrapChromiumHardwareAccelerationEnabled(rawSettings);
  if (!enabled) {
    // Electron 只能在 app ready 前关闭 Chromium 硬件加速。
    // 因此设置页保存后必须在下一次 main 进程最早期读取并应用，不能等到 whenReady。
    app.disableHardwareAcceleration();
  }
  return enabled;
}
