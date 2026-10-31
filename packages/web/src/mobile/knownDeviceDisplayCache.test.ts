import { describe, expect, it, vi } from "vitest";
import {
  findKnownDeviceDisplay,
  KNOWN_DEVICE_DISPLAY_MAX_ENTRIES,
  KNOWN_DEVICE_DISPLAY_STORAGE_KEY,
  readKnownDeviceDisplays,
  rememberKnownDeviceDisplay,
  type KnownDeviceStorage,
} from "./knownDeviceDisplayCache.js";

function memoryStorage(
  initial?: string,
): KnownDeviceStorage & { readonly raw: () => string | null } {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    raw: () => value,
  };
}

describe("手机 known-device 显示缓存", () => {
  it("只在 mid/name 都存在时缓存，并按上限保留最近条目", () => {
    const storage = memoryStorage();
    for (let index = 0; index < KNOWN_DEVICE_DISPLAY_MAX_ENTRIES + 3; index += 1) {
      rememberKnownDeviceDisplay(
        { deviceMid: `mid-${index}`, name: `Desk ${index}`, now: index + 1 },
        storage,
      );
    }
    expect(readKnownDeviceDisplays(storage)).toHaveLength(KNOWN_DEVICE_DISPLAY_MAX_ENTRIES);
    expect(findKnownDeviceDisplay("mid-0", storage)).toBeUndefined();
    expect(findKnownDeviceDisplay("mid-10", storage)).toMatchObject({ name: "Desk 10" });
    expect(rememberKnownDeviceDisplay({ deviceMid: "only-mid" }, storage)).toHaveLength(
      KNOWN_DEVICE_DISPLAY_MAX_ENTRIES,
    );
  });

  it("损坏 JSON/非数组/非法条目静默丢弃，不抛错", () => {
    const storage = memoryStorage("{not-json");
    expect(readKnownDeviceDisplays(storage)).toEqual([]);
    storage.setItem(KNOWN_DEVICE_DISPLAY_STORAGE_KEY, JSON.stringify({ entries: [] }));
    expect(readKnownDeviceDisplays(storage)).toEqual([]);
    storage.setItem(
      KNOWN_DEVICE_DISPLAY_STORAGE_KEY,
      JSON.stringify([
        { deviceMid: "mid-1", name: "Valid", lastSeenAt: 1 },
        { deviceMid: "", name: "Missing mid", lastSeenAt: 1 },
        { deviceMid: "mid-2", name: "", lastSeenAt: 1 },
        { deviceMid: "mid-3", name: "Bad time", lastSeenAt: "yesterday" },
      ]),
    );
    expect(readKnownDeviceDisplays(storage).map((entry) => entry.deviceMid)).toEqual(["mid-1"]);
  });

  it("即使调用方/旧存储夹带 secret 字段，也只写回公开显示字段", () => {
    const storage = memoryStorage(
      JSON.stringify([
        {
          deviceMid: "mid-1",
          name: "Desk",
          lastSeenAt: 1,
          passHash: "secret-pass-hash",
          token: "secret-token",
          proof: "secret-proof",
        },
      ]),
    );
    const read = readKnownDeviceDisplays(storage);
    expect(read).toEqual([{ deviceMid: "mid-1", name: "Desk", lastSeenAt: 1 }]);
    rememberKnownDeviceDisplay(
      {
        deviceMid: "mid-1",
        name: "Desk",
        appVersion: "3.16.2",
        now: 2,
      },
      storage,
    );
    const raw = storage.raw() ?? "";
    expect(raw).not.toContain("secret-pass-hash");
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("secret-proof");
    expect(raw).not.toContain("passHash");
    expect(raw).not.toContain("token");
    expect(raw).toContain("3.16.2");
  });

  it("localStorage 不可用或写满时降级，不影响连接流程", () => {
    const read = vi.fn(() => {
      throw new Error("storage denied");
    });
    const storage: KnownDeviceStorage = { getItem: read, setItem: vi.fn() };
    expect(readKnownDeviceDisplays(storage)).toEqual([]);
    expect(() =>
      rememberKnownDeviceDisplay({ deviceMid: "mid-1", name: "Desk" }, storage),
    ).not.toThrow();
  });
});
