/**
 * 配对二维码/链接构造（与官方 `buildWebRemoteControlExternalQrUrl` 参数一致）：
 * `<baseUrl>?sid&hash&t&mid&name&app_version(&theme)`。
 * theme 取自桌面主题种子（packages/ui 的 Theme 并集），移动端据此对齐亮/暗色；
 * main 进程不 import UI 包，这里以局部联合类型复刻同一并集。
 */
export type WebRemoteControlThemeSeed = "light" | "dark" | "zai-light" | "zai-dark" | "system";
export interface WebRemoteControlQrUrlParams {
  baseUrl: string;
  deviceSid: string;
  passHash: string;
  timestamp: number;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
  theme?: WebRemoteControlThemeSeed;
}

export function buildWebRemoteControlQrUrl(params: WebRemoteControlQrUrlParams): string {
  const url = new URL(params.baseUrl);
  // passHash 即配对 secret 的哈希，本身就是链接凭证；只进 query，不进日志。
  url.searchParams.set("sid", params.deviceSid);
  url.searchParams.set("hash", params.passHash);
  url.searchParams.set("t", String(params.timestamp));
  if (params.deviceMid?.trim()) {
    url.searchParams.set("mid", params.deviceMid);
  }
  if (params.deviceName?.trim()) {
    url.searchParams.set("name", params.deviceName);
  }
  if (params.appVersion?.trim()) {
    url.searchParams.set("app_version", params.appVersion);
  }
  if (params.theme?.trim()) {
    url.searchParams.set("theme", params.theme);
  }
  return url.toString();
}
