import { selectBrowserFileData } from "@zcode/ui";
import {
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  resolveLocaleFromLanguageTag,
  type IPlatformService,
} from "@zcode/shared";

import { registerAppControlNavigationHandler } from "#src/app-control-navigation/renderer.js";
import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    selectFileData: selectBrowserFileData,
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.zcode.selectDirectory(),
    selectFile: () => window.zcode.selectFile(),
    selectFiles: () => window.zcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.zcode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.zcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.zcode.onRemoteSessionClosed(handler),
    onBotRemoteWorkspaceReconnected: (handler) =>
      window.zcode.onBotRemoteWorkspaceReconnected(handler),
    activateOrSetWorkspace: (path) =>
      window.zcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.zcode.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.zcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.zcode.requestSourceSettingsAttachment(sourceServerId),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.zcode.bindRemoteWorkspaceSessionContext?.(context) ??
      // 旧 preload 没有该方法：与 attach 失败同一结构，调用方按 ok:false 处理。
      Promise.resolve({
        ok: false as const,
        reason: "not-found" as const,
        recoveryRequested: false,
      }),
    disposeRemoteSession: (sessionId) => window.zcode.disposeRemoteSession(sessionId),
    startWebRemoteControl: (request) => window.zcode.startWebRemoteControl(request),
    stopWebRemoteControl: () => window.zcode.stopWebRemoteControl(),
    getWebRemoteControlStatus: () => window.zcode.getWebRemoteControlStatus(),
    refreshWebRemoteControlPairing: (request) =>
      window.zcode.refreshWebRemoteControlPairing(request),
    syncWebRemoteControlWorkspaces: (payload) =>
      window.zcode.syncWebRemoteControlWorkspaces(payload),
    syncWebRemoteControlTasks: (payload) => window.zcode.syncWebRemoteControlTasks(payload),
    onWebRemoteControlStatusChanged: (handler) =>
      window.zcode.onWebRemoteControlStatusChanged(handler),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.zcode.onWebRemoteControlReconnectWorkspace(handler),
    isDockerAvailable: () => window.zcode.isDockerAvailable(),
    listWSLDistros: () => window.zcode.listWSLDistros(),
    listDockerContainers: () => window.zcode.listDockerContainers(),
    listSSHConfigAliases: () => window.zcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.zcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.zcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.zcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.zcode.openExternal(url),
    openFeedback: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.zcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.zcode.openInFileManager(path),
    openExternalFile: (path) => window.zcode.openExternalFile(path),
    getBuiltinProviderConfigFile: () => window.zcode.getBuiltinProviderConfigFile(),
    openCuaPermissionOnboarding: window.zcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.zcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.zcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.zcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    requestCuaPermissions: window.zcode.requestCuaPermissions
      ? () =>
          window.zcode.requestCuaPermissions?.() ??
          Promise.resolve({ ok: false, accessibility: false, screenRecording: false })
      : undefined,
    openCuaPermissionSystemSettings: window.zcode.openCuaPermissionSystemSettings
      ? () => window.zcode.openCuaPermissionSystemSettings?.() ?? Promise.resolve(false)
      : undefined,
    startCuaHelperPermissionDrag: window.zcode.startCuaHelperPermissionDrag
      ? () => window.zcode.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyRendererReady: () => window.zcode.notifyRendererReady(),
    reportDiagnostic: (record) => window.zcode.reportDiagnostic(record),
    reportRendererHeapSample: (sample) => window.zcode.reportRendererHeapSample(sample),
    reportLocalTtftBatch: (batch) => window.zcode.reportLocalTtftBatch(batch),
    showTaskNotification: (payload) => window.zcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.zcode.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.zcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.zcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.zcode.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.zcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.zcode.onFocusTab(handler),
    onNewTab: (handler) => window.zcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.zcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.zcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.zcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.zcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.zcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.zcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.zcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.zcode.getDesktopWindowChromeState
      ? () => window.zcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.zcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.zcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.zcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.zcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.zcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.zcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.zcode.onTaskNotificationClick(handler),
    // 显式 App 导航：登记/回执都由当前 renderer 的 generation 收口；旧 preload 缺失时保持不可用。
    onAppControlNavigation: (handler) => {
      const subscribe = window.zcode.onAppControlNavigationMessage;
      const send = window.zcode.sendAppControlNavigation;
      if (!subscribe || !send) return () => {};
      const generation = crypto.randomUUID();
      return registerAppControlNavigationHandler(
        {
          subscribe: (listener) => subscribe(listener),
          register: (activeGeneration) => send({ type: "register", generation: activeGeneration }),
          unregister: (activeGeneration) =>
            send({ type: "unregister", generation: activeGeneration }),
          reply: (message) => send({ type: "result", ...message }),
        },
        handler,
        generation,
      );
    },
    exportLogs: () => window.zcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.zcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.zcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.zcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.zcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.zcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.zcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.zcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.zcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.zcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.zcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.zcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.zcode.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.zcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.zcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.zcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.zcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.zcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.zcode.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.zcode.getInstalledEditors(filePath),
    // 系统关联应用是桌面独有的本机能力：preload 缺席时保持 undefined，UI 据此不出入口。
    getFileApplications: window.zcode.getFileApplications
      ? (target) => window.zcode.getFileApplications!(target)
      : undefined,
    openFileWithApplication: window.zcode.openFileWithApplication
      ? (applicationId, target) => window.zcode.openFileWithApplication!(applicationId, target)
      : undefined,
    getApplicationIcon: (bundleId) =>
      window.zcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.zcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.zcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.zcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.zcode.getSystemLocale?.() ??
      Promise.resolve(resolveLocaleFromLanguageTag(navigator.language)),
    setTitleBarTheme: (theme) => window.zcode.setTitleBarTheme(theme),
  };
}
