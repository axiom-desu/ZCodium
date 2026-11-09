import { describe, expect, it, vi } from "vitest";
import { resolveDeviceAuth } from "./deviceAuth.js";

function createParams(options: {
  persisted: { deviceSid: string; passHash: string } | null;
  pairValid: boolean;
}) {
  const clearPersisted = vi.fn(async () => {});
  return {
    clearPersisted,
    params: {
      persisted: options.persisted,
      hasPair: () => options.pairValid,
      clearPersisted,
      createPassword: () => "fresh-password",
      createPassHash: (password: string) => `hash:${password}`,
    },
  };
}

describe("resolveDeviceAuth", () => {
  it("keeps a persisted device only when the endpoint still knows the pair", async () => {
    const { params, clearPersisted } = createParams({
      persisted: { deviceSid: "sid-1", passHash: "hash-1" },
      pairValid: true,
    });
    await expect(resolveDeviceAuth(params)).resolves.toEqual({
      mode: "persisted",
      deviceSid: "sid-1",
      passHash: "hash-1",
    });
    expect(clearPersisted).not.toHaveBeenCalled();
  });

  it("re-registers and clears storage when the in-memory pair is gone", async () => {
    // 端点重启后配对表必为空：不能先用失效 sid 去注册再让用户刷新页面才出二维码。
    const { params, clearPersisted } = createParams({
      persisted: { deviceSid: "stale-sid", passHash: "stale-hash" },
      pairValid: false,
    });
    await expect(resolveDeviceAuth(params)).resolves.toEqual({
      mode: "register",
      passHash: "hash:fresh-password",
    });
    expect(clearPersisted).toHaveBeenCalledOnce();
  });

  it("registers on first run", async () => {
    const { params, clearPersisted } = createParams({ persisted: null, pairValid: false });
    await expect(resolveDeviceAuth(params)).resolves.toEqual({
      mode: "register",
      passHash: "hash:fresh-password",
    });
    expect(clearPersisted).not.toHaveBeenCalled();
  });
});
