import { describe, expect, it } from "vitest";
import { resolveDynamicWorkflowEngineSupport } from "#src/zcode-agent/dynamicWorkflowEngineSupport.js";
import { resolveZCodeAgentRuntimeKind } from "#src/zcode-agent/zcodeAgentProcessManager.js";

describe("resolveDynamicWorkflowEngineSupport", () => {
  it("Rust CLI 没有 DWF 引擎，必须报告 unsupported", () => {
    expect(
      resolveDynamicWorkflowEngineSupport({ ZCODE_AGENT_SERVER_RUNTIME: "zcode-cli-rust" }),
    ).toBe("unsupported");
    // 大小写/空白不影响判定（与 zcodeAgentProcessManager 的归一化一致）。
    expect(
      resolveDynamicWorkflowEngineSupport({ ZCODE_AGENT_SERVER_RUNTIME: " ZCode-CLI-Rust " }),
    ).toBe("unsupported");
  });

  it("未知 runtime 选择不把功能打开（启动侧会拒绝，能力读取 fail-closed）", () => {
    expect(
      resolveDynamicWorkflowEngineSupport({ ZCODE_AGENT_SERVER_RUNTIME: "zcode-cli-preview" }),
    ).toBe("unsupported");
  });

  it("TS runtime（未设置 / ts / 自定义命令）沿用既有假设", () => {
    expect(resolveDynamicWorkflowEngineSupport({})).toBe("supported");
    expect(resolveDynamicWorkflowEngineSupport({ ZCODE_AGENT_SERVER_RUNTIME: "ts" })).toBe(
      "supported",
    );
    // 自定义命令过去也按 TS 语义工作；收窄会静默关掉现存部署的功能。
    expect(
      resolveDynamicWorkflowEngineSupport({
        ZCODE_AGENT_SERVER_COMMAND: "/opt/zcode/zcode",
      }),
    ).toBe("supported");
  });

  it("能力判定走 runtime 选择 owner 的公开解析，不再各写一份 env 规则", () => {
    assertRuntimeKind({}, "ts");
    assertRuntimeKind({ ZCODE_AGENT_SERVER_COMMAND: "/opt/zcode/zcode" }, "ts");
    assertRuntimeKind({ ZCODE_AGENT_SERVER_RUNTIME: " ZCode-CLI-Rust " }, "zcode-cli-rust");
    expect(() => resolveZCodeAgentRuntimeKind({ ZCODE_AGENT_SERVER_RUNTIME: "typo" })).toThrow();
  });
});

function assertRuntimeKind(
  env: Record<string, string | undefined>,
  expected: "ts" | "zcode-cli-rust",
) {
  expect(resolveZCodeAgentRuntimeKind(env)).toBe(expected);
}
