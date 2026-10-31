import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  persistedMessagesShowDynamicWorkflow,
  resolveInitialDynamicWorkflowToolsActivated,
} from "../src/runtime/methods/dynamic-workflow-activation.js";
import { resolveRuntimeDynamicWorkflowToolsIncluded } from "../src/runtime/helpers/tool-allowlist.js";

describe("onDemand 工具面门", () => {
  it("alwaysOn / 缺席 = 出生即激活；onDemand 出生不激活", () => {
    assert.equal(resolveInitialDynamicWorkflowToolsActivated({}), true);
    assert.equal(
      resolveInitialDynamicWorkflowToolsActivated({ dynamicWorkflowToolsOnDemand: false }),
      true,
    );
    assert.equal(
      resolveInitialDynamicWorkflowToolsActivated({ dynamicWorkflowToolsOnDemand: true }),
      false,
    );
  });

  it("enabled ∧ activated 才注册；过期 config 不能把 onDemand 重新打开", () => {
    const base = { dynamicWorkflowEnabled: true };
    assert.equal(
      resolveRuntimeDynamicWorkflowToolsIncluded({
        config: base,
        dynamicWorkflowToolsActivated: false,
      }),
      false,
    );
    assert.equal(
      resolveRuntimeDynamicWorkflowToolsIncluded({
        config: base,
        dynamicWorkflowToolsActivated: true,
      }),
      true,
    );
    assert.equal(
      resolveRuntimeDynamicWorkflowToolsIncluded({
        config: { dynamicWorkflowEnabled: false },
        dynamicWorkflowToolsActivated: true,
      }),
      false,
    );
  });
});

describe("冷恢复历史判定", () => {
  it("持久化里出现过 /workflow 或十个工具之一即激活", () => {
    const messages = (parts: unknown[], role = "user") => [{ info: { role }, parts }] as never;
    assert.equal(
      persistedMessagesShowDynamicWorkflow(
        messages([{ type: "text", text: "  /workflow build it" }]),
      ),
      true,
    );
    assert.equal(
      persistedMessagesShowDynamicWorkflow(
        messages([{ type: "tool", tool: "CreateWorkflow" }], "assistant"),
      ),
      true,
    );
    assert.equal(
      persistedMessagesShowDynamicWorkflow(messages([{ type: "text", text: "/workflows" }])),
      false,
    );
    // 普通文本里提到工具名不算历史工作流。
    assert.equal(
      persistedMessagesShowDynamicWorkflow(
        messages([{ type: "text", text: "please use CreateWorkflow" }], "assistant"),
      ),
      false,
    );
  });
});
