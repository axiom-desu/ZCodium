import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PermissionCapabilityGroup,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type ToolPart,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
  isOfficialCuaImageRefText,
} from "@zcode/zcode-cua/frame-contract";
import type { ExecutableToolCall, ToolEntry } from "../src/tool/types.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import {
  backgroundTaskKind,
  buildWorkflowNotificationOriginMeta,
  workflowSnapshotTerminal,
  workflowTaskSubject,
} from "../src/tool/executor/background-task-workflow-projection.js";
import {
  canCancelBackgroundTask,
  getBackgroundTaskSnapshot,
  hasBackgroundTaskSnapshotProvider,
  hasDirectBackgroundTaskWaiter,
  lifecycleProvider,
  waitForBackgroundTaskSnapshot,
} from "../src/tool/executor/background-task-providers.js";
import {
  appendPreToolAdditionalContextsToErrorResult,
  isEmptyToolName,
  resolveModelOutputEntry,
} from "../src/tool/executor/call-runner-helpers.js";
import { formatBackgroundTaskNotification } from "../src/tool/executor/background-task-notifications.js";
import {
  createPermissionDecision,
  resolveCapabilityFor,
} from "../src/permission/capability-resolution.js";
import {
  matchesRule,
  matchesRuleContent,
  matchesRuleScope,
} from "../src/permission/rule-evaluation.js";
import {
  levenshteinDistance,
  isCachedReadFresh,
} from "../src/tool/handlers/read-file-state-cache.js";
import {
  MAX_INLINE_OUTPUT_BYTES,
  createExecutionRequest,
} from "../src/tool/handlers/bash-execution-request.js";
import { normalizeSeedEdges, validateAddedEdges } from "../src/workflow/lifecycle-internals.js";
import {
  reconcileWorkflowSnapshotForResume,
  cancelWorkflowSnapshot,
  reopenWorkflowGraphNode,
  applyWorkflowGraphSeed,
  applyWorkflowNodePromptUpdates,
} from "../src/workflow/lifecycle.js";
import {
  cloneRuntimeMessageEntry,
  invalidateRuntimeTokenUsage,
  isRuntimeAttachmentEntry,
} from "../src/agent/message-history.js";
import {
  assistantTextFromParts,
  metadataFromUserParts,
  providerToolNameFromPart,
} from "../src/agent/session-history-metadata.js";
import { formatMcpToolResult } from "../src/mcp/index.js";
import { sanitizeHookDiagnostics, unwrapHookCallbackResult } from "../src/hooks/callback-result.js";

function toolCall(name: string, input: unknown = {}): ExecutableToolCall {
  return { id: `call-${name}`, name, input };
}

function deps(value: Record<string, unknown>): ToolExecutorDeps {
  return value as unknown as ToolExecutorDeps;
}

describe("core tool/services slice: extracted providers", () => {
  it("keeps provider fields and receiver binding when moving lifecycle lookup out", async () => {
    const executionPort = {
      label: "execution",
      async getBackgroundTask(taskId: string) {
        return { status: "running", taskId, owner: this.label };
      },
      async waitForBackgroundTask(taskId: string) {
        return { status: "completed", taskId, owner: this.label };
      },
      cancelBackgroundTask() {},
    };
    const workflowPort = {
      label: "workflow",
      async getTask(taskId: string) {
        return { status: "running", taskId, owner: this.label };
      },
      async waitForTask(taskId: string) {
        return { status: "completed", taskId, owner: this.label };
      },
    };
    const bashDeps = deps({ executionPort });
    const bash = toolCall("Bash");
    assert.equal(canCancelBackgroundTask(bashDeps, bash), true);
    assert.equal(hasBackgroundTaskSnapshotProvider(bashDeps, bash), true);
    assert.equal(hasDirectBackgroundTaskWaiter(bashDeps, bash), true);
    assert.deepEqual(await getBackgroundTaskSnapshot(bashDeps, bash, "t1"), {
      status: "running",
      taskId: "t1",
      owner: "execution",
    });
    assert.deepEqual(await waitForBackgroundTaskSnapshot(bashDeps, bash, "t1"), {
      status: "completed",
      taskId: "t1",
      owner: "execution",
    });

    const workflowDeps = deps({ workflowPort });
    const workflow = toolCall("Workflow");
    // legacy Workflow 没有取消入口：cancellable 恒 false，不能随 executionPort 能力漂移。
    assert.equal(canCancelBackgroundTask(workflowDeps, workflow), false);
    assert.equal(hasBackgroundTaskSnapshotProvider(workflowDeps, workflow), true);
    assert.equal(hasDirectBackgroundTaskWaiter(workflowDeps, workflow), true);

    const subagentDeps = deps({
      subagentPort: { getTask: async () => undefined, stopTask() {} },
    });
    assert.equal(canCancelBackgroundTask(subagentDeps, toolCall("Agent")), true);

    // 未知工具回退到 executionPort 的通用后台面；缺省 cancels 为 false。
    const plainDeps = deps({ executionPort: { getBackgroundTask: async () => undefined } });
    const plain = toolCall("SomeTool");
    assert.equal(canCancelBackgroundTask(plainDeps, plain), false);
    assert.equal(hasDirectBackgroundTaskWaiter(plainDeps, plain), false);
    assert.deepEqual(lifecycleProvider(deps({}), plain), { cancellable: false });
  });

  it("keeps dwf cancellable/waiter semantics and snapshot signature stable", () => {
    const dynamicWorkflowRunPort = {
      getTask: async () => ({ status: "running" }),
      waitForTask: async () => ({ status: "completed" }),
      cancel: async () => {},
    };
    const call = toolCall("CreateWorkflow");
    const provider = lifecycleProvider(deps({ dynamicWorkflowRunPort }), call);
    assert.equal(provider.cancellable, true);
    assert.equal(typeof provider.getSnapshot, "function");
    assert.equal(typeof provider.waitForTerminal, "function");
    assert.equal(lifecycleProvider(deps({}), call).cancellable, undefined);
  });

  it("keeps terminal status mapping, superseded reason, title fallback and task kind", () => {
    assert.deepEqual(workflowSnapshotTerminal("failed", undefined), { runStatus: "errored" });
    assert.deepEqual(workflowSnapshotTerminal("cancelled", { status: "cancelled" } as never), {
      runStatus: "stopped",
    });
    assert.deepEqual(
      workflowSnapshotTerminal("cancelled", {
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "superseded",
      } as never),
      { runStatus: "stopped", stopReason: "superseded" },
    );
    assert.equal(workflowSnapshotTerminal("running", { status: "running" } as never), undefined);

    assert.equal(
      workflowTaskSubject(
        toolCall("CreateWorkflow", { description: "desc" }),
        "run",
        undefined,
        undefined,
      ),
      "desc",
    );
    assert.equal(
      workflowTaskSubject(
        toolCall("CreateWorkflow", { name: "input-name" }),
        "run",
        { name: "snapshot-name" } as never,
        undefined,
      ),
      "snapshot-name",
    );
    assert.equal(
      workflowTaskSubject(toolCall("CreateWorkflow"), "run", undefined, undefined),
      "run",
    );

    assert.equal(backgroundTaskKind("Agent"), "subagent");
    assert.equal(backgroundTaskKind("CreateWorkflow"), "workflow");
    assert.equal(backgroundTaskKind("ResumeWorkflowRun"), "workflow");
    assert.equal(backgroundTaskKind("Workflow"), "bash");
    assert.equal(backgroundTaskKind("Bash"), "bash");

    const meta = buildWorkflowNotificationOriginMeta(
      toolCall("CreateWorkflow", { description: "Deploy" }),
      "run-1",
      "completed",
      {
        status: "completed",
        runStatus: "completed",
        output: "done",
        startedAt: new Date(1000),
        completedAt: new Date(1500),
      } as never,
      undefined,
    );
    assert.equal(meta.backgroundSource, "workflow");
    assert.equal(meta.title, "Deploy");
    assert.equal(meta.workId, "run-1");
    assert.equal(meta.workflowNotification?.kind, "terminal");
    assert.equal(meta.workflowNotification?.status, "completed");
    assert.equal(meta.workflowNotification?.result, "done");
    assert.equal(meta.workflowNotification?.resultForm, "prose");
    assert.equal(meta.workflowNotification?.durationMs, 500);
  });

  it("keeps bash/workflow notification text and non-terminal suppression", () => {
    const bashDeps = deps({});
    const bash = toolCall("Bash", { description: "build", command: "pnpm build" });
    const text = formatBackgroundTaskNotification(bashDeps, bash, "task-1", "cancelled", {
      status: "cancelled",
    } as never);
    assert.match(text ?? "", /Background command "build" was stopped/);
    assert.equal(
      formatBackgroundTaskNotification(
        bashDeps,
        toolCall("Read"),
        "task-1",
        "completed",
        undefined,
      ),
      undefined,
    );
  });
});

describe("core tool/services slice: execution and permission seams", () => {
  it("keeps CUA frame protection dormant and call-runner projections identical", () => {
    assert.equal(isOfficialCuaImageRefText('{"image_ref":"frame-1"}'), false);
    assert.equal(
      attestOfficialCuaFrameContent([], OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION),
      undefined,
    );

    const entry = {
      metadata: { name: "Read" },
      resultBudget: { maxInlineBytes: 1, maxModelBytes: 1 },
    } as unknown as ToolEntry;
    const output = { content: [] };
    assert.equal(resolveModelOutputEntry(entry, output), entry);
    assert.equal(isEmptyToolName("   "), true);
    assert.equal(isEmptyToolName(" Read "), false);

    const failed = {
      success: false,
      error: new Error("denied"),
      modelContent: "model text",
    };
    assert.equal(appendPreToolAdditionalContextsToErrorResult(failed as never, []), failed);
    assert.match(
      String(
        appendPreToolAdditionalContextsToErrorResult(failed as never, ["hook context"])
          .modelContent,
      ),
      /model text\n\n\[Hook additional context\]\n#1\nhook context/,
    );
  });

  it("keeps the permission decision field set and rule scope semantics", () => {
    const context = {
      toolName: "Bash",
      input: { command: "git status" },
      riskLevel: "high",
      mode: "build" as const,
    };
    const capability = resolveCapabilityFor(context, { alwaysAsk: true });
    assert.equal(capability.riskLevel, "medium");
    assert.equal(capability.destructive, true);
    assert.equal(capability.sideEffectScope, "workspace");
    assert.equal(capability.needsApproval, true);
    assert.equal(capability.alwaysAsk, true);

    const decision = createPermissionDecision("ask", context, capability, "tool.alwaysAsk");
    assert.deepEqual(Object.keys(decision).sort(), [
      "allowed",
      "alwaysAsk",
      "decision",
      "escalated",
      "mode",
      "reason",
      "riskLevel",
      "ruleId",
      "sideEffectScope",
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.escalated, true);
    assert.equal(decision.alwaysAsk, true);

    assert.equal(matchesRuleContent("git status", "git:*"), true);
    assert.equal(matchesRuleContent("git status", "git*"), true);
    assert.equal(matchesRuleContent("git status", "git status"), true);
    assert.equal(matchesRuleContent("npm install", "git:*"), false);

    const readCapability = resolveCapabilityFor({ ...context, toolName: "Read", input: {} });
    assert.equal(
      matchesRule(
        { toolName: "Edit", ruleContent: "a.ts" },
        { ...context, toolName: "Write", input: { file_path: "a.ts" } },
        resolveCapabilityFor({ ...context, toolName: "Write", input: { file_path: "a.ts" } }),
      ),
      true,
    );
    assert.equal(
      matchesRuleScope({ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }, "Bash", {
        ...readCapability,
        permissionCapabilityGroup: PermissionCapabilityGroup.OfficialCua,
      }),
      true,
    );
    assert.equal(
      matchesRuleScope(
        { toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME },
        "Bash",
        readCapability,
      ),
      false,
    );
  });

  it("keeps read cache freshness and max inline output budget", () => {
    const stat = { mtimeMs: 10, sizeBytes: 3, revision: { id: "r1", mtimeMs: 10 } };
    assert.equal(
      isCachedReadFresh(
        { mtimeMs: 10.9, sizeBytes: 3, isPartialView: false } as never,
        stat as never,
      ),
      true,
    );
    assert.equal(
      isCachedReadFresh({ mtimeMs: 10, sizeBytes: 3, isPartialView: true } as never, stat as never),
      false,
    );
    assert.equal(levenshteinDistance("read.ts", "read.ts"), 0);
    assert.equal(levenshteinDistance("read.ts", "reed.ts"), 1);

    const request = createExecutionRequest(
      { command: "echo hi", run_in_background: true, dangerouslyDisableSandbox: true },
      {
        traceId: "trace",
        spanId: "span",
        abortSignal: new AbortController().signal,
        workingDirectory: "/workspace",
        workspaceRoot: "/workspace",
        sessionId: "session",
        toolCallId: "call",
        bashShellSelection: undefined,
      } as never,
      { defaultTimeoutMs: 1000, maxTimeoutMs: 2000 },
    );
    assert.equal(request.outputLimit?.maxInlineBytes, MAX_INLINE_OUTPUT_BYTES);
    assert.equal(request.outputLimit?.persistOutput, "always");
    assert.equal(request.sandbox?.enabled, false);
    assert.equal(request.captureCwdAfterSuccess, undefined);
  });

  it("keeps lifecycle public re-exports and pure seed edge validation", () => {
    for (const fn of [
      reconcileWorkflowSnapshotForResume,
      cancelWorkflowSnapshot,
      reopenWorkflowGraphNode,
      applyWorkflowGraphSeed,
      applyWorkflowNodePromptUpdates,
    ]) {
      assert.equal(typeof fn, "function");
    }
    const node = (id: string) => ({ id, title: id, prompt: "", dependsOn: [], status: "pending" });
    const edges = normalizeSeedEdges(
      [{ from: "a", to: "b" }],
      [{ ...node("c"), dependsOn: ["b", "b"] }] as never,
      [{ from: "a", to: "b" }],
    );
    assert.deepEqual(edges, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    assert.throws(
      () => validateAddedEdges([node("a"), node("b")] as never, [], [], [{ from: "a", to: "a" }]),
      /self-loop/,
    );
    assert.throws(
      () =>
        validateAddedEdges(
          [node("a"), node("b")] as never,
          [{ from: "a", to: "b" }],
          [],
          [{ from: "b", to: "a" }],
        ),
      /cycle/,
    );
    assert.throws(
      () => validateAddedEdges([node("a")] as never, [], [], [{ from: "a", to: "missing" }]),
      /unknown target/,
    );
  });
});

describe("core tool/services slice: history, MCP and hook projections", () => {
  it("keeps message-history cloning and token invalidation pure", () => {
    const entry = {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi", source: { id: "s" } }],
        toolName: "",
      },
      metadata: { source: "assistant" },
      tokens: { total: 9, input: 4, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
    };
    const cloned = cloneRuntimeMessageEntry(entry as never);
    assert.notEqual(cloned, entry);
    assert.equal((cloned as { message: { toolName: string } }).message.toolName, "");
    assert.notEqual(
      (cloned as { message: { content: unknown } }).message.content,
      entry.message.content,
    );
    const tokens = invalidateRuntimeTokenUsage(entry.tokens as never);
    assert.deepEqual(tokens, {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    assert.equal(isRuntimeAttachmentEntry({ kind: "attachment", content: "x" } as never), true);
    assert.equal(isRuntimeAttachmentEntry({ message: entry.message } as never), false);
  });

  it("keeps serialized part metadata projections exact", () => {
    const toolPart = {
      type: "tool",
      tool: "fallback",
      metadata: { providerToolName: "" },
    } as unknown as ToolPart;
    assert.equal(providerToolNameFromPart(toolPart), "");
    assert.equal(
      providerToolNameFromPart({
        type: "tool",
        tool: "fallback",
        metadata: {},
      } as unknown as ToolPart),
      "fallback",
    );
    assert.equal(
      assistantTextFromParts([
        { type: "text", text: "keep" },
        { type: "text", text: "drop", ignored: true },
        { type: "reasoning", text: "reason" },
      ] as never),
      "keep",
    );
    assert.equal(
      metadataFromUserParts([{ type: "text", text: "hello" } as never]).source,
      "real_user",
    );
    assert.equal(
      metadataFromUserParts([{ type: "text", text: "reminder", synthetic: true } as never]).source,
      "legacy_synthetic",
    );
  });

  it("keeps MCP result formatting (empty structured content, error presentation)", () => {
    assert.equal(formatMcpToolResult("plain"), '"plain"');
    assert.equal(
      formatMcpToolResult({
        content: [{ type: "text", text: "hello" }],
        structuredContent: {},
        isError: false,
      }),
      "hello",
    );
    assert.equal(
      formatMcpToolResult({
        content: [{ type: "text", text: "failed" }],
        isError: true,
      }),
      "MCP tool returned an error:\nfailed",
    );
    assert.equal(
      formatMcpToolResult({
        content: [{ type: "text", text: "failed" }],
        isError: true,
        _meta: {
          [ZCODE_MCP_ERROR_PRESENTATION_META_KEY]: ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
        },
      }),
      "failed",
    );
    const imageContent = formatMcpToolResult({
      content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    assert.ok(Array.isArray(imageContent));
    assert.match(
      String((imageContent[0] as { dataUrl?: string }).dataUrl),
      /^data:image\/png;base64,/,
    );
  });

  it("keeps hook callback unwrap and diagnostics sanitization", () => {
    const output = { decision: "allow" };
    assert.deepEqual(unwrapHookCallbackResult({ kind: "hookCallbackResult", output }), {
      output,
      diagnostics: undefined,
    });
    assert.deepEqual(unwrapHookCallbackResult(output as never), { output, diagnostics: undefined });
    assert.equal(
      sanitizeHookDiagnostics({
        errorMessage: "  boom  ",
        stderrPreview: "   ",
      })?.errorMessage,
      "boom",
    );
    assert.equal(sanitizeHookDiagnostics({ errorMessage: "   " }), undefined);
  });
});
