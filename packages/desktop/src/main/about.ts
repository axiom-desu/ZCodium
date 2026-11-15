import type { BrowserWindow, MessageBoxReturnValue } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  toZhOrEnLocale,
  type Locale,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_ENV,
  ZCODE_VERSION,
} from "@zcode/shared";
import { createCustomAboutDialogHtml } from "./aboutWindow.js";

interface DesktopBuildMetadata {
  appVersion?: string;
  upstreamBaseline?: string;
  buildCommitId?: string;
  buildTime?: string;
  releaseBuildNumber?: number | null;
  electronBuilderVersion?: string;
}

interface AboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  releaseBuildNumber: number | null;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

interface AboutSnapshotOptions {
  appVersion?: string;
  buildMetadata?: DesktopBuildMetadata | null;
  environment?: string;
  runtimeVersions?: Pick<NodeJS.ProcessVersions, "electron" | "chrome" | "node" | "v8">;
  osInfo?: {
    type: string;
    platform: string;
    release: string;
    version: string;
    arch: string;
    hostname: string;
  };
}

// 自定义 About 内容本体是 256x280；原生窗口如果同尺寸会让内容贴满透明窗口边界。
// 这里给 BrowserWindow 额外留出背景呼吸空间，避免正式 About 看起来比 demo 更局促。
const ABOUT_WINDOW_WIDTH = 256;
const ABOUT_WINDOW_HEIGHT = 312;
// 展示名取运行时应用名（app.setName(runtimeApplicationName) 之后的 app.name，构建期
// 产品身份经 desktopRuntimeEnv 解析）：正式包是 ZCodium Exp，Preview 包自 2026-10 起是
// ZCodium Rust。之前这里硬编码 "ZCodium Exp"，Preview 包的 About 会显示错误的产品名。
const ABOUT_APPLICATION_NAME_FALLBACK = "ZCodium Exp";

const ABOUT_MESSAGES: Record<
  "zh-CN" | "en-US",
  {
    aboutTitle: (applicationName: string) => string;
    buildLabel: string;
    okButtonLabel: string;
    optimizedForAppleSilicon: string;
    copyright: (year: number, applicationName: string) => string;
  }
> = {
  "zh-CN": {
    aboutTitle: (applicationName) => `关于 ${applicationName}`,
    buildLabel: "构建",
    okButtonLabel: "确定",
    optimizedForAppleSilicon: "已针对 Apple Silicon 优化。",
    copyright: (year, applicationName) => `版权所有 © ${year} ${applicationName}。`,
  },
  "en-US": {
    aboutTitle: (applicationName) => `About ${applicationName}`,
    buildLabel: "Build",
    okButtonLabel: "OK",
    optimizedForAppleSilicon: "Optimized for Apple Silicon.",
    copyright: (year, applicationName) => `Copyright © ${year} ${applicationName}.`,
  },
};

function normalizeValue(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizePackageVersion(version: string | undefined): string {
  const normalized = normalizeValue(version);
  return normalized === "unknown" ? normalized : normalized.replace(/^[^\d]*/, "") || normalized;
}

function getAboutMessages(locale: Locale): (typeof ABOUT_MESSAGES)[keyof typeof ABOUT_MESSAGES] {
  // About 弹窗只内置中英；其它界面语言回退英文，避免回退 DEFAULT_LOCALE 时意外显示中文。
  return ABOUT_MESSAGES[toZhOrEnLocale(locale)];
}

/**
 * About 展示名：优先运行时应用名（`app.setName(runtimeApplicationName)` 后的 `app.name`，
 * 随构建期产品身份变化——正式包 ZCodium Exp，Preview 包 ZCodium Rust），空值时回退。
 */
export function resolveAboutApplicationName(appName: string | undefined | null): string {
  return appName?.trim() || ABOUT_APPLICATION_NAME_FALLBACK;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveBuildMetadataPath(): string {
  return join(import.meta.dirname, "../metadata/build-meta.json");
}

export function readBuildMetadata(
  filePath = resolveBuildMetadataPath(),
): DesktopBuildMetadata | null {
  // 之前 About 直接读取编译时注入的常量，commit/time 只能代表 tsup 那一刻。
  // 问题原因：构建和打包是分步执行的，安装包里的 about 需要的是“最终产物”的统一元数据，而不是某个编译子步骤的快照。
  // 这里优先读打包前生成的 build-meta.json；只有缺文件时才回退到编译时常量。
  return readJsonFile<DesktopBuildMetadata>(filePath);
}

function resolveElectronBuilderVersion(buildMetadata: DesktopBuildMetadata | null): string {
  if (buildMetadata?.electronBuilderVersion) {
    return normalizeValue(buildMetadata.electronBuilderVersion);
  }

  const packageJson = readJsonFile<{ devDependencies?: Record<string, string> }>(
    join(import.meta.dirname, "../../package.json"),
  );
  return normalizePackageVersion(packageJson?.devDependencies?.["electron-builder"]);
}

export function createAboutSnapshot(options: AboutSnapshotOptions = {}): AboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const osInfo = options.osInfo ?? {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(options.appVersion ?? buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    releaseBuildNumber:
      typeof buildMetadata?.releaseBuildNumber === "number"
        ? buildMetadata.releaseBuildNumber
        : null,
    environment: normalizeValue(options.environment ?? ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: resolveElectronBuilderVersion(buildMetadata),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

/**
 * About 展示的构建信息。滚动更新下不展示内部版本串（`3.14.3-20261008.1234`）：
 * 官方发布构建带 CI 注入的发布序号，展示 `2026-10-08 · #4382`；
 * 自建构建没有发布序号，展示短 commit id，让用户报问题时能直接定位源码。
 */
export function formatAboutBuildValue(
  snapshot: Pick<AboutSnapshot, "buildTime" | "buildCommitId" | "releaseBuildNumber">,
): string {
  const buildDate = /^\d{4}-\d{2}-\d{2}/.exec(normalizeValue(snapshot.buildTime))?.[0];
  const date = buildDate ?? "unknown";
  const releaseBuildNumber = snapshot.releaseBuildNumber;
  if (
    typeof releaseBuildNumber === "number" &&
    Number.isInteger(releaseBuildNumber) &&
    releaseBuildNumber > 0
  ) {
    return `${date} · #${releaseBuildNumber}`;
  }

  return `${date} · ${normalizeValue(snapshot.buildCommitId)}`;
}

export function formatAboutDetail(snapshot: AboutSnapshot): string {
  return [
    `Build: ${formatAboutBuildValue(snapshot)}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}

function formatAboutCopyright(
  applicationName: string,
  year = new Date().getFullYear(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  return getAboutMessages(locale).copyright(year, applicationName);
}

function formatAboutOptimizationLine(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    return getAboutMessages(locale).optimizedForAppleSilicon;
  }

  return "";
}

function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

export async function showAboutDialog(
  parentWindow?: BrowserWindow,
  locale: Locale = DEFAULT_LOCALE,
): Promise<MessageBoxReturnValue> {
  const { app, BrowserWindow } = await import("electron");
  const snapshot = createAboutSnapshot({
    appVersion: app.getVersion(),
    buildMetadata: readBuildMetadata(),
  });
  const aboutMessages = getAboutMessages(locale);
  const applicationName = resolveAboutApplicationName(app.name);
  // 之前只有 macOS 使用自绘 About，Windows/Linux 仍走原生 message box。
  // 问题原因：各平台原生消息框的排版、图标和按钮样式差异很大，无法复用 macOS 参考样式。
  // 这里统一使用自绘 modal，保证 About 的品牌展示和多语言文案在三端一致。
  const iconPath = resolveAboutIconPath(app.isPackaged);
  const aboutWindow = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height: ABOUT_WINDOW_HEIGHT,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: aboutMessages.aboutTitle(applicationName),
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createCustomAboutDialogHtml({
        applicationName,
        buildLabel: aboutMessages.buildLabel,
        buildValue: formatAboutBuildValue(snapshot),
        copyright: formatAboutCopyright(applicationName, undefined, locale),
        optimizationLine: formatAboutOptimizationLine(snapshot, locale),
        okButtonLabel: aboutMessages.okButtonLabel,
      }),
    )}`,
  );
  return { response: 0, checkboxChecked: false };
}
