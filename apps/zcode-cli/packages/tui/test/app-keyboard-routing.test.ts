import assert from "node:assert/strict";
import test from "node:test";
import { KeyEvent } from "@mbears/opentui-core";
import { handleApprovalRoutingKey } from "../src/app-keyboard-approval.js";
import { handleComposerCtrlCKey } from "../src/app-keyboard-ctrl-c.js";
import { handleEscapeDismissalKey, handleTabCompletionKey } from "../src/app-keyboard-dismissal.js";
import { handleReadOnlyViewKey } from "../src/app-keyboard-readonly.js";
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  createCtrlCExitGuard,
} from "../src/app-keyboard-helpers.js";
import { createSidebarShortcutState } from "../src/app-sidebar-shortcut.js";
import type { ApprovalPrompt } from "../src/app-model.js";

function key(
  name: string,
  overrides: {
    ctrl?: boolean;
    meta?: boolean;
    option?: boolean;
    shift?: boolean;
    raw?: string;
  } = {},
): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: overrides.ctrl ?? false,
    meta: overrides.meta ?? false,
    shift: overrides.shift ?? false,
    option: overrides.option ?? false,
    sequence: "",
    number: false,
    raw: overrides.raw ?? name,
    eventType: "press",
    source: "raw",
  });
}

function approvalFixture(overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt {
  return {
    cleanup() {},
    reject() {},
    resolve() {},
    // 夹具：request 字段不参与键盘路由断言，审批面板行为由 app-approval 自己的测试覆盖。
    request: {} as ApprovalPrompt["request"],
    selectedDecision: "allow_once",
    ...overrides,
  };
}

test("只读视图捕获普通按键，但保留返回、复制与翻页键", () => {
  const calls: string[] = [];
  const run = (event: KeyEvent) =>
    handleReadOnlyViewKey({
      consumeKey: (pressed) => {
        calls.push(`consume:${pressed.name}`);
        pressed.preventDefault();
      },
      copyCurrentSelection: () => {
        calls.push("copy");
        return true;
      },
      ctrlCExitGuard: createCtrlCExitGuard(),
      key: event,
      readOnlyView: { back: () => calls.push("back") },
      setStatus: () => calls.push("status"),
      shortcutState: createSidebarShortcutState(),
      toggleSidebar: () => false,
      toggleSidebarSection: () => false,
    });

  const escape = key("escape");
  run(escape);
  assert.deepEqual(calls, ["consume:escape", "back"]);
  assert.equal(escape.defaultPrevented, true);

  calls.length = 0;
  run(key("c", { ctrl: true }));
  assert.deepEqual(calls, ["consume:c", "copy"]);

  calls.length = 0;
  run(key("pagedown"));
  assert.deepEqual(calls, []);

  calls.length = 0;
  run(key("x"));
  assert.deepEqual(calls, ["consume:x"]);
});

test("审批态下 /quit 走 approval origin，其余按键继续交给审批面板", () => {
  const statuses: string[] = [];
  const quitCalls: Array<{ origin: string | undefined; value: string | undefined }> = [];
  const pendingQuitRef = { current: undefined as string | undefined };
  const run = (event: KeyEvent, approval: ApprovalPrompt) =>
    handleApprovalRoutingKey({
      approval,
      consumeKey: (pressed) => pressed.preventDefault(),
      ctrlCExitGuard: createCtrlCExitGuard(),
      key: event,
      pendingQuitRef,
      quitHint: "Quit",
      setApprovalQueue: () => {},
      setStatus: (status) => statuses.push(status),
      tryQuit: (value, origin) => {
        quitCalls.push({ origin, value });
        return true;
      },
    });

  const editingOther = approvalFixture({
    questionState: {
      annotations: {},
      answers: {},
      currentQuestionIndex: 0,
      editingOther: true,
      input: { questions: [] },
      multiSelections: {},
      otherBuffer: "/quit",
      otherText: {},
      reviewing: false,
      selectedOptionIndex: 0,
    },
  });
  assert.equal(run(key("return"), editingOther), true);
  assert.deepEqual(quitCalls, [{ origin: "approval", value: "/quit" }]);

  const slash = key("/");
  assert.equal(run(slash, approvalFixture()), true);
  assert.equal(pendingQuitRef.current, "/");
  assert.equal(slash.defaultPrevented, true);
  assert.ok(statuses.length > 0);
});

test("Ctrl-C 依次让位给复制、草稿清空和二次确认退出", () => {
  const events: string[] = [];
  const guard = createCtrlCExitGuard();
  const run = (input: {
    copy?: boolean;
    draftValue?: string;
    guard?: ReturnType<typeof createCtrlCExitGuard>;
    keyEvent?: KeyEvent;
  }) =>
    handleComposerCtrlCKey({
      abortControllerRef: {
        current: { abort: () => events.push("abort") } as AbortController,
      },
      consumeKey: () => {},
      copyCurrentSelection: () => input.copy ?? false,
      ctrlCExitGuard: input.guard ?? guard,
      draftValue: input.draftValue ?? "",
      key: input.keyEvent ?? key("c", { ctrl: true }),
      onExit: () => events.push("exit"),
      setDraftAttachments: () => events.push("attachments"),
      setDraftValue: (value) => events.push(`draft:${value}`),
      setStatus: (status) => events.push(`status:${status}`),
    });

  assert.equal(run({ copy: true }), true);
  assert.deepEqual(events, []);

  assert.equal(run({ draftValue: "/plan" }), true);
  assert.deepEqual(events, ["draft:", "attachments", `status:${PROMPT_DRAFT_CLEARED_STATUS}`]);

  events.length = 0;
  assert.equal(run({}), true);
  assert.deepEqual(events, [`status:${CTRL_C_EXIT_PROMPT}`]);

  events.length = 0;
  assert.equal(run({ guard: { lastPressAtMs: Date.now() } }), true);
  assert.deepEqual(events, ["abort", "exit"]);
});

test("Tab 只补全已打开的候选集，补全后关闭候选", () => {
  const drafted: string[] = [];
  const cleared: string[] = [];
  const handled = handleTabCompletionKey({
    consumeKey: () => {},
    effortSelection: { selectedIndex: 0 },
    filteredEffortOptions: [{ id: "high", label: "High" }],
    filteredModeOptions: [],
    filteredModelOptions: [],
    filteredSlashCommands: [],
    key: key("tab"),
    modelSelection: undefined,
    modeSelection: undefined,
    setDraftValue: (value) => drafted.push(value),
    setEffortSelection: () => cleared.push("effort"),
    setModelSelection: () => cleared.push("model"),
    setModeSelection: () => cleared.push("mode"),
    setSlashSelection: () => cleared.push("slash"),
    slashSelection: undefined,
  });

  assert.equal(handled, true);
  assert.deepEqual(drafted, ["/effort high"]);
  assert.deepEqual(cleared, ["effort"]);
});

test("Escape 逐层关闭候选，全部关闭后才中止输出", () => {
  const statuses: string[] = [];
  const aborts: string[] = [];
  const run = (overrides: { busy?: boolean; modelSelection?: { selectedIndex: number } }) =>
    handleEscapeDismissalKey({
      abortControllerRef: {
        current: { abort: () => aborts.push("abort") } as AbortController,
      },
      busy: overrides.busy ?? false,
      consumeKey: () => {},
      effortSelection: undefined,
      key: key("escape"),
      modelSelection: overrides.modelSelection,
      modeSelection: undefined,
      setEffortSelection: () => {},
      setModelSelection: () => statuses.push("clear-model"),
      setModeSelection: () => {},
      setSlashSelection: () => {},
      setStatus: (status) => statuses.push(status),
      slashSelection: undefined,
    });

  assert.equal(run({ modelSelection: { selectedIndex: 0 } }), true);
  assert.deepEqual(statuses, ["clear-model", "Model suggestions dismissed."]);

  statuses.length = 0;
  assert.equal(run({ busy: true }), true);
  assert.deepEqual(aborts, ["abort"]);
  assert.deepEqual(statuses, ["Pausing current output..."]);

  statuses.length = 0;
  assert.equal(run({}), true);
  assert.deepEqual(statuses, ["No active output to pause. Press Ctrl-C twice to exit."]);
});
