import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

/**
 * 设置搜索的可见性投影。只表达「这一行在当前环境下是否真的存在」，
 * 不持有任何设置值、密钥或动态资源正文。
 */
export interface SettingsSearchAvailability {
  desktop: boolean;
  macDesktop: boolean;
  windowsHost: boolean;
  tray: boolean;
  notWindows: boolean;
  workflow: boolean;
}

/**
 * 设置搜索索引：翻译 key 同时作为稳定定位 id（`SettingsRow.searchId`）。
 *
 * 只登记本仓当前可见的固定设置行；上游 3.18 的 `mobilePush`/`dataSync`/`shares`/
 * `projects`/`archives`/付费与 coding plan 行在本仓已移除，不能写进索引。
 * 本仓没有 `agentBehavior` 分区，相关行按现有 `general` 登记。
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "settings.locale",
    section: "general",
    description: "settings.localeDescription",
    visibility: "all",
  },
  {
    id: "settings.interfaceMode",
    section: "general",
    description: "settings.interfaceMode.description",
    visibility: "all",
  },
  {
    id: "settings.terminalProfile",
    section: "general",
    description: "settings.terminalProfileDescription",
    visibility: "all",
  },
  {
    id: "settings.terminalFontFamily",
    section: "general",
    description: "settings.terminalFontFamilyDescription",
    visibility: "all",
  },
  {
    id: "settings.integratedTerminalShell",
    section: "general",
    description: "settings.integratedTerminalShellDescription",
    visibility: "windowsHost",
  },
  {
    id: "settings.toolSearch",
    section: "general",
    description: "settings.toolSearchDescription",
    visibility: "all",
  },
  {
    id: "settings.nativeSearchEnhancements",
    section: "general",
    description: "settings.nativeSearchEnhancementsDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxy",
    section: "general",
    description: "settings.httpProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyNoProxy",
    section: "general",
    description: "settings.httpProxyNoProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyCaCertPath",
    section: "general",
    description: "settings.httpProxyCaCertPathDescription",
    visibility: "all",
  },
  {
    id: "settings.desktopChromiumHardwareAcceleration",
    section: "general",
    description: "settings.desktopChromiumHardwareAccelerationDescription",
    visibility: "desktop",
  },
  {
    id: "settings.receivePreviewUpdates",
    section: "general",
    description: "settings.receivePreviewUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.autoDownloadAndInstallUpdates",
    section: "general",
    description: "settings.autoDownloadAndInstallUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.notification",
    section: "general",
    description: "settings.notificationDescription",
    visibility: "all",
  },
  {
    id: "settings.notificationSound",
    section: "general",
    description: "settings.notificationSoundDescription",
    visibility: "all",
  },
  {
    id: "settings.closeToTrayOnWindows",
    section: "general",
    description: "settings.closeToTrayOnWindowsDescription",
    visibility: "tray",
  },
  {
    id: "settings.keepAwakeWhileRunning",
    section: "general",
    description: "settings.keepAwakeWhileRunningDescription",
    visibility: "desktop",
  },
  {
    id: "settings.dataBaseDir",
    section: "general",
    description: "settings.dataBaseDirDescription",
    visibility: "all",
  },
  {
    id: "settings.onboarding",
    section: "general",
    description: "settings.onboardingDescription",
    visibility: "all",
  },
  {
    id: "settings.zcodeInteractionBehavior",
    section: "general",
    description: "settings.zcodeInteractionBehaviorDescription",
    visibility: "all",
  },
  {
    id: "settings.askUserQuestionAutoResolution",
    section: "general",
    description: "settings.askUserQuestionAutoResolutionDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowReasoning",
    section: "general",
    description: "settings.messageStreamShowReasoningDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowTodos",
    section: "general",
    description: "settings.messageStreamShowTodosDescription",
    visibility: "all",
  },
  {
    id: "settings.toolGroupingExplore",
    section: "general",
    description: "settings.toolGroupingExploreDescription",
    visibility: "all",
  },
  {
    id: "settings.toolGroupingTerminal",
    section: "general",
    description: "settings.toolGroupingTerminalDescription",
    visibility: "all",
  },
  {
    id: "settings.toolGroupingChanges",
    section: "general",
    description: "settings.toolGroupingChangesDescription",
    visibility: "all",
  },
  {
    id: "settings.taskAutoArchive",
    section: "general",
    description: "settings.taskAutoArchiveDescription",
    visibility: "all",
  },
  {
    id: "settings.taskAutoArchiveDays",
    section: "general",
    description: "settings.taskAutoArchiveDaysDescription",
    visibility: "all",
  },
  {
    id: "chat.officeSuggestions.setting",
    section: "general",
    description: "chat.officeSuggestions.settingDescription",
    visibility: "all",
  },
  {
    id: "settings.dynamicWorkflow",
    section: "general",
    description: "settings.dynamicWorkflowDescription",
    visibility: "workflow",
  },
  {
    id: "settings.themeMode",
    section: "appearance",
    description: "settings.themeModeDescription",
    visibility: "all",
  },
  {
    id: "settings.uiFontSize",
    section: "appearance",
    description: "settings.uiFontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.lightTheme",
    section: "appearance",
    description: "settings.lightThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.darkTheme",
    section: "appearance",
    description: "settings.darkThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.showLineNumbers",
    section: "appearance",
    description: "settings.showLineNumbersDescription",
    visibility: "all",
  },
  {
    id: "settings.wrapLongLines",
    section: "appearance",
    description: "settings.wrapLongLinesDescription",
    visibility: "all",
  },
  {
    id: "settings.fontSize",
    section: "appearance",
    description: "settings.fontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.browser.control.title",
    section: "browser",
    description: "settings.browser.control.description",
    visibility: "all",
  },
  {
    id: "settings.browser.import.title",
    section: "browser",
    description: "settings.browser.import.description",
    visibility: "notWindows",
  },
  {
    id: "settings.embeddedBrowserAllowInsecureCertificates",
    section: "browser",
    description: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.browser.clearCache.title",
    section: "browser",
    description: "settings.browser.clearCache.description",
    visibility: "all",
  },
  {
    id: "settings.browser.clearAll.title",
    section: "browser",
    description: "settings.browser.clearAll.description",
    visibility: "all",
  },
  {
    id: "settings.browser.htmlClickOpensBrowser",
    section: "browser",
    description: "settings.browser.htmlClickOpensBrowserDescription",
    visibility: "desktop",
  },
  {
    id: "settings.memory.workspaceMemory",
    section: "memory",
    description: "settings.memoryDescription",
    visibility: "all",
  },
] as const satisfies readonly {
  id: string;
  section: SettingsSectionId;
  description: string;
  visibility: "all" | keyof SettingsSearchAvailability;
}[];

export type SettingsSearchId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

/** 某行在当前环境下是否可用；`all` 不参与门禁。 */
export function isSettingsSearchItemVisible(
  visibility: "all" | keyof SettingsSearchAvailability,
  availability: SettingsSearchAvailability,
): boolean {
  return visibility === "all" || availability[visibility];
}
