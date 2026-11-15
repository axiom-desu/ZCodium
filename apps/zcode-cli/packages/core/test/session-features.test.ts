// 会话能力标签（上游 3.18.2 F12）：结果派生、ToolSearch 模式、entry 合并、冷恢复并集。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ModelRequestSessionFeature,
  PermissionCapabilityGroup,
  SESSION_ENTRY_SESSION_FEATURES,
} from "@zcode/contracts";

import {
  parseSessionFeaturesEntryData,
  readSessionFeatures,
  recordSessionFeature,
  recordSessionFeatureFromToolSearchExposure,
  restoreSessionFeaturesOnResume,
  sessionFeatureFromToolSearchExposure,
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
} from "../src/runtime/session-features/contract.js";

function createRuntime(entry?: unknown) {
  const saved: unknown[] = [];
  const runtime = {
    logger: { info() {}, warn() {} },
    registry: {
      get: () => ({}),
    },
    rootTraceContext: {} as never,
    sessionFeatures: new Set<string>(),
    sessionFeaturesWrite: Promise.resolve(),
    sessionId: "s1",
    sessionPersisted: true,
    sessionStore: {
      sessionEntries: async () => (entry === undefined ? [] : [{ data: entry }]),
      saveSessionEntry: async (value: unknown) => {
        saved.push(value);
      },
    },
  };
  return { runtime: runtime as never, saved };
}

describe("session features", () => {
  it("按工具结果派生标签", () => {
    assert.deepEqual(
      sessionFeaturesFromToolResult({
        output: { status: "backgrounded" },
        success: true,
        toolName: "CreateWorkflow",
      }),
      [
        ModelRequestSessionFeature.WorkflowAuto,
        ModelRequestSessionFeature.WorkflowAutoAttempt,
      ],
    );
    assert.deepEqual(
      sessionFeaturesFromToolResult({
        error: { type: "permission_denied" },
        output: {},
        success: false,
        toolName: "CreateWorkflow",
      }),
      [],
    );
    assert.deepEqual(
      sessionFeaturesFromToolResult({
        output: {},
        success: true,
        toolName: "LocalToolSearch",
      }),
      [ModelRequestSessionFeature.ToolSearchCalled],
    );
    assert.deepEqual(
      sessionFeaturesFromToolResult({
        output: { _meta: { "zcode/nodeReplBrowserUse": true, "zcode/nodeReplComputerUse": true } },
        success: true,
        toolName: "mcp__node_repl__js",
      }),
      [ModelRequestSessionFeature.BrowserUse, ModelRequestSessionFeature.ComputerUse],
    );
    assert.deepEqual(
      sessionFeaturesFromToolResult(
        { output: "ok", success: true, toolName: "computer_use" },
        { permissionCapabilityGroup: PermissionCapabilityGroup.OfficialCua },
      ),
      [ModelRequestSessionFeature.ComputerUse],
    );
  });

  it("ToolSearch 模式取请求实际生效值", () => {
    assert.equal(
      sessionFeatureFromToolSearchExposure({ enabled: true, mode: "local" }),
      ModelRequestSessionFeature.ToolSearchLocal,
    );
    assert.equal(
      sessionFeatureFromToolSearchExposure({ enabled: true, mode: "native" }),
      ModelRequestSessionFeature.ToolSearchNative,
    );
    assert.equal(sessionFeatureFromToolSearchExposure({ enabled: false, mode: "off" }), undefined);
  });

  it("打点只增不减，entry 合并写入包含历史标签", async () => {
    const { runtime, saved } = createRuntime({ features: ["browser_use"] });
    assert.equal(
      recordSessionFeature.call(runtime, { feature: ModelRequestSessionFeature.ToolSearchCalled }),
      true,
    );
    assert.equal(
      recordSessionFeature.call(runtime, { feature: ModelRequestSessionFeature.ToolSearchCalled }),
      false,
    );
    recordSessionFeatureFromToolSearchExposure.call(
      runtime,
      { enabled: true, mode: "local" },
      undefined,
    );
    await runtime.sessionFeaturesWrite;
    assert.deepEqual((saved.at(-1) as { data: unknown }).data, {
      features: ["browser_use", "tool_search_called", "tool_search_local"],
    });
    assert.deepEqual(readSessionFeatures(runtime), [
      "browser_use",
      "tool_search_called",
      "tool_search_local",
    ]);
  });

  it("冷恢复 = entry ∪ 持久化历史推导，词表外标签忽略", async () => {
    const { runtime } = createRuntime({ features: ["tool_search_local", "unknown_feature"] });
    const messages = [
      {
        info: { role: "user" },
        parts: [{ text: "/workflow build a thing", type: "text" }],
      },
      {
        info: { role: "assistant" },
        parts: [
          {
            state: {
              metadata: { display: { kind: "create_workflow", ok: true } },
              status: "completed",
            },
            tool: "CreateWorkflow",
            type: "tool",
          },
        ],
      },
    ];
    assert.deepEqual(
      [...sessionFeaturesFromPersistedMessages(messages as never)].sort(),
      ["workflow_auto", "workflow_auto_attempt", "workflow_cmd"],
    );
    await restoreSessionFeaturesOnResume.call(runtime, messages as never, undefined);
    assert.deepEqual(readSessionFeatures(runtime), [
      "tool_search_local",
      "workflow_auto",
      "workflow_auto_attempt",
      "workflow_cmd",
    ]);
    assert.deepEqual(parseSessionFeaturesEntryData({ features: ["browser_use", "nope"] }), [
      "browser_use",
    ]);
  });

  it("子 runtime 从空集合开始，不继承父会话的 config", () => {
    const parent = createRuntime().runtime;
    recordSessionFeature.call(parent, { feature: ModelRequestSessionFeature.WorkflowCmd });
    const child = createRuntime().runtime;
    assert.deepEqual(readSessionFeatures(child), []);
    assert.equal(SESSION_ENTRY_SESSION_FEATURES, "runtime/session_features");
  });
});
