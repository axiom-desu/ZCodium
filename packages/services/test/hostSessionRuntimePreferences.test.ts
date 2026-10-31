import { describe, expect, it } from "vitest";
import { zcodeSessionRuntimePreferencesResultSchema, type AppSettings } from "@zcode/shared";
import { buildHostSessionRuntimePreferences } from "#src/zcode-agent/hostSessionRuntimePreferences.js";

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return overrides as AppSettings;
}

/** 偏好是 Host → CLI 的线上字节：解析一次 strict schema 证明与旧/新 CLI 兼容。 */
function parseForWire(payload: unknown) {
  return zcodeSessionRuntimePreferencesResultSchema.parse(payload);
}

describe("Host 会话偏好（新建/冷恢复 materialization 的线上字节）", () => {
  it("缺省偏好：工具搜索 Off，其余按既有默认", () => {
    const payload = buildHostSessionRuntimePreferences({ settings: settings(), scope: "shared" });
    expect(payload).toEqual({
      askUserQuestionAutoResolutionEnabled: true,
      nativeSearchEnhancementsEnabled: true,
      toolSearchMode: "off",
      memoryEnabled: false,
      modelContextBudgetStrategy: "preflight-v1",
    });
    expect(parseForWire(payload).toolSearchMode).toBe("off");
  });

  it("保存的 auto/local 原样进入字节；不会回退成 off", () => {
    for (const mode of ["auto", "local"] as const) {
      const payload = buildHostSessionRuntimePreferences({
        settings: settings({ toolSearchMode: mode }),
        scope: "shared",
      });
      expect(payload.toolSearchMode).toBe(mode);
      expect(parseForWire(payload).toolSearchMode).toBe(mode);
    }
  });

  it("显式关闭的布尔偏好不被默认值覆盖", () => {
    const payload = buildHostSessionRuntimePreferences({
      settings: settings({
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: true,
      }),
      scope: "shared",
    });
    expect(payload).toMatchObject({
      askUserQuestionAutoResolutionEnabled: false,
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: true,
    });
  });

  it("integratedTerminalShell 只对 user-execution 作用域下发", () => {
    const shell = {
      mode: "shell" as const,
      dialect: "git-bash" as const,
      id: "git-bash",
      label: "Git Bash",
      path: "C:/Program Files/Git/bin/bash.exe",
    };
    const shared = buildHostSessionRuntimePreferences({
      settings: settings({ integratedTerminalShell: shell }),
      scope: "shared",
    });
    const userExecution = buildHostSessionRuntimePreferences({
      settings: settings({ integratedTerminalShell: shell }),
      scope: "user-execution",
    });
    expect(shared).not.toHaveProperty("integratedTerminalShell");
    expect(userExecution.integratedTerminalShell).toEqual(shell);
  });
});
