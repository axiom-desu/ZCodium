export type WebRemoteControlDeviceAuth =
  | { mode: "register"; passHash: string }
  | { mode: "persisted"; deviceSid: string; passHash: string };

/**
 * 解析本次启动使用的设备鉴权。
 *
 * 配对表只在端点内存里，应用重启后持久化 sid 必然失效；旧流程先按 persisted 注册、失败后
 * 才让用户刷新（刷新时已清空 authStorage → 走注册 → 才有二维码）。启动前先验证配对事实，
 * 失效就直接重新注册，首次出码不再依赖刷新页面。
 */
export async function resolveDeviceAuth(params: {
  persisted: { deviceSid: string; passHash: string } | null;
  hasPair(deviceSid: string, passHash: string): boolean;
  clearPersisted(): Promise<void>;
  createPassword(): string;
  createPassHash(password: string): string;
}): Promise<WebRemoteControlDeviceAuth> {
  if (params.persisted && params.hasPair(params.persisted.deviceSid, params.persisted.passHash)) {
    return {
      mode: "persisted",
      deviceSid: params.persisted.deviceSid,
      passHash: params.persisted.passHash,
    };
  }
  if (params.persisted) await params.clearPersisted();
  return {
    mode: "register",
    passHash: params.createPassHash(params.createPassword()),
  };
}
