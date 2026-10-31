/**
 * 手机 known-device 的**只读显示**缓存。
 *
 * 只缓存配对 URL 已公开的桌面显示字段（deviceMid/name/appVersion），用于首页提示；
 * 不参与鉴权、admission、路由或重连，也绝不持久化 passHash/token/proof。
 * 有界、损坏时静默降级，避免 localStorage 成为第二份业务状态。
 * pairing 参数仍由 protocol.readPairingParamsFromLocation 从现有 query 读取；本模块不解析或改写 URL fragment。
 */
interface KnownDeviceDisplay {
  deviceMid: string;
  name: string;
  appVersion?: string;
  lastSeenAt: number;
}

export interface KnownDeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const KNOWN_DEVICE_DISPLAY_STORAGE_KEY = "zcode.mobile.known-device.display.v1";
export const KNOWN_DEVICE_DISPLAY_MAX_ENTRIES = 8;
const MAX_NAME_LENGTH = 120;
const MAX_MID_LENGTH = 160;
const MAX_VERSION_LENGTH = 64;

function resolveStorage(storage?: KnownDeviceStorage): KnownDeviceStorage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeEntry(value: unknown): KnownDeviceDisplay | null {
  if (!isRecord(value)) return null;
  const deviceMid = normalizeText(value.deviceMid, MAX_MID_LENGTH);
  const name = normalizeText(value.name, MAX_NAME_LENGTH);
  const lastSeenAt =
    typeof value.lastSeenAt === "number" &&
    Number.isFinite(value.lastSeenAt) &&
    value.lastSeenAt > 0
      ? value.lastSeenAt
      : undefined;
  if (!deviceMid || !name || lastSeenAt === undefined) return null;
  const appVersion = normalizeText(value.appVersion, MAX_VERSION_LENGTH);
  // 只重建白名单字段；passHash/token/proof 等未知字段不会被带回调用方或再次写盘。
  return {
    deviceMid,
    name,
    ...(appVersion ? { appVersion } : {}),
    lastSeenAt,
  };
}

export function readKnownDeviceDisplays(storage?: KnownDeviceStorage): KnownDeviceDisplay[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  let parsed: unknown;
  try {
    const raw = target.getItem(KNOWN_DEVICE_DISPLAY_STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byMid = new Map<string, KnownDeviceDisplay>();
  for (const value of parsed) {
    const entry = normalizeEntry(value);
    if (!entry) continue;
    const previous = byMid.get(entry.deviceMid);
    if (!previous || entry.lastSeenAt >= previous.lastSeenAt) byMid.set(entry.deviceMid, entry);
  }
  return [...byMid.values()]
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
    .slice(-KNOWN_DEVICE_DISPLAY_MAX_ENTRIES);
}

export function rememberKnownDeviceDisplay(
  input: {
    deviceMid?: string | null;
    name?: string | null;
    appVersion?: string | null;
    now?: number;
  },
  storage?: KnownDeviceStorage,
): KnownDeviceDisplay[] {
  const deviceMid = normalizeText(input.deviceMid, MAX_MID_LENGTH);
  const name = normalizeText(input.name, MAX_NAME_LENGTH);
  // 只有 PUBLIC pairing 字段同时存在时才缓存；缺 name 不猜测、不写空记录。
  if (!deviceMid || !name) return readKnownDeviceDisplays(storage);
  const appVersion = normalizeText(input.appVersion, MAX_VERSION_LENGTH);
  const next: KnownDeviceDisplay = {
    deviceMid,
    name,
    ...(appVersion ? { appVersion } : {}),
    lastSeenAt: input.now ?? Date.now(),
  };
  const entries = [
    ...readKnownDeviceDisplays(storage).filter((entry) => entry.deviceMid !== deviceMid),
    next,
  ].slice(-KNOWN_DEVICE_DISPLAY_MAX_ENTRIES);
  const target = resolveStorage(storage);
  if (target) {
    try {
      target.setItem(KNOWN_DEVICE_DISPLAY_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // 隐私模式/配额失败只影响显示提示，不影响连接。
    }
  }
  return entries;
}

export function findKnownDeviceDisplay(
  deviceMid: string | null | undefined,
  storage?: KnownDeviceStorage,
): KnownDeviceDisplay | undefined {
  const normalized = normalizeText(deviceMid, MAX_MID_LENGTH);
  if (!normalized) return undefined;
  return readKnownDeviceDisplays(storage).find((entry) => entry.deviceMid === normalized);
}
