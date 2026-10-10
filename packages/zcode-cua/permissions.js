/**
 * Computer Use 权限契约 + cua-driver 后端。
 *
 * 取代闭源 Helper broker 的权限服务：状态直接来自 cua-driver 的 `check_permissions`
 * （macOS 上是 Accessibility / Screen Recording），宿主侧再决定如何展示。
 * 契约形状与 UI（`ComputerUseSection`）长期消费的一致，避免设置项重写。
 */

/**
 * @param {boolean | undefined} value
 * @returns {"granted" | "stale" | "denied" | "unknown"}
 */
function toPermissionState(value) {
  if (value === true) return "granted";
  if (value === false) return "denied";
  return "unknown";
}

function parseStructured(result) {
  const text = result?.structuredJson;
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * cua-driver `check_permissions` 的 structuredJson → UI 契约。
 * 非 macOS 平台没有 TCC 概念，返回 unavailable（UI 本就不在这些平台渲染权限项）。
 */
export function projectCuaPermissionStatus(raw, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      available: false,
      reason: `Computer Use permissions are only tracked on macOS (current: ${platform}).`,
    };
  }
  const data = raw && typeof raw === "object" ? raw : {};
  const accessibility = toPermissionState(data.accessibility);
  const screenRecording = toPermissionState(data.screen_recording ?? data.screenRecording);
  if (accessibility === "unknown" && screenRecording === "unknown") {
    return { available: false, reason: "cua-driver did not report macOS permission state." };
  }
  return {
    available: true,
    platform,
    grantOwner: null,
    owner: null,
    grantOwnerDisplayName: options.grantOwnerDisplayName ?? null,
    accessibility,
    screenRecording,
    ...(typeof data.accessibility_probe_ok === "boolean"
      ? { accessibilityProbeOk: data.accessibility_probe_ok }
      : {}),
  };
}

export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available === true;
}

/**
 * 只有调用方显式允许、且状态不是明确已授予时才做抓屏探测（隐私：默认不抓屏）。
 */
export function shouldRunCuaScreenCaptureProbe(state, options = {}) {
  if (options?.probeScreenCapture !== true) return false;
  return state !== "granted";
}

/**
 * cua-driver 后端的 `ICuaPermissionService` 实现。
 *
 * 宿主注入一个能调 `check_permissions` 的 client（同进程 SDK 或 daemon connect）。
 * 没有 client 时保持 fail-closed，返回 unavailable 而不是伪造已授权。
 */
export function createCuaDriverPermissionService(options = {}) {
  const platform = options.platform ?? process.platform;
  return {
    async getStatus(_workspacePath, _workspaceIdentity, _queryOptions) {
      const client = options.client;
      if (!client || typeof client.callTool !== "function") {
        return { available: false, reason: "cua-driver client is not available." };
      }
      try {
        const result = await client.callTool(
          "check_permissions",
          JSON.stringify({ prompt: false }),
        );
        return projectCuaPermissionStatus(parseStructured(result), {
          platform,
          ...(options.grantOwnerDisplayName
            ? { grantOwnerDisplayName: options.grantOwnerDisplayName }
            : {}),
        });
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async restartHelper() {
      // 新路径没有 Helper；daemon 生命周期由宿主管理，权限查询总是取实时值，无需重启动作。
      return { ok: true };
    },
  };
}
