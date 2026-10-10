/**
 * macOS TCC 权限的宿主侧入口。
 *
 * 闭源 `ZCode Computer Use.app` Helper 原先靠「拖进 系统设置 > 隐私与安全性」拿授权；现在由
 * cua-driver 的 Electron 入口代劳。`requestMacOSPermissions` 会真的弹 TCC 窗，**必须**在
 * Electron main 进程、`app.whenReady()` 之后调用，授权才归属 ZCode.app 而不是 MCP worker。
 *
 * 分工：**读**状态走 `check_permissions`（见 ./permissions.js，只读标志、不需要授权）；
 * 本模块只管**申请**与**打开设置面板**。
 */

const loadCuaDriverElectronEntry = () => import("@trycua/cua-driver/electron");

export async function loadMacOSPermissionHost(options = {}) {
  const load = options.load ?? loadCuaDriverElectronEntry;
  try {
    return (await load()) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 触发 TCC 申请并返回归一化状态。拿不到入口（非 macOS、未打包、原生库缺失）返回 undefined，
 * 调用方据此保持 fail-closed，不假装已授权。
 */
export async function requestMacOSPermissionsFromHost(options = {}) {
  const host = await loadMacOSPermissionHost(options);
  const status = host?.requestMacOSPermissions?.();
  if (!status || typeof status !== "object") return undefined;
  return {
    accessibility: status.accessibility === true,
    screenRecording: status.screenRecording === true,
  };
}

export function hasRequiredMacOSPermissions(status) {
  return status?.accessibility === true && status?.screenRecording === true;
}

/** 打开「屏幕录制」设置面板；打不开返回 false，不抛。 */
export async function openMacOSScreenRecordingSettingsPanel(options = {}) {
  const host = await loadMacOSPermissionHost(options);
  if (typeof host?.openMacOSScreenRecordingSettings !== "function") return false;
  try {
    await host.openMacOSScreenRecordingSettings();
    return true;
  } catch {
    return false;
  }
}
