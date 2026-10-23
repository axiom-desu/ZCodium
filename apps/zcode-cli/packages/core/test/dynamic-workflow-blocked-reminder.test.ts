// ============================================================
// 「run 还欠着决定、主代理闲着」的提醒：文案、载荷与 runtime 接线
// ============================================================
// 钟的规则在 workflow-blocked-reminder-clock.test.ts；这里钉另外三件事：
//   1. 模型读到的 `<workflow-blocked>` 文本（逐字的下一步、两次的收尾句、截断诚实）；
//   2. runtime 宿主：从任务注册表取在飞的 run、从端口快照取开集、铸 `workflowBlocked` 载荷并走既有的
//      后台通知入口（同一条队列/账本/分支围栏，不新增投递路径）；
//   3. 接线点：队列排空 = 空闲沿、命令开始 = 忙、用户 prompt / steer = 新的一对、开集事件 = 该 run 新的一对。
// 时钟用 node:test 的 mock.timers（`setTimeout` + `Date`），零真实等待。

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { workflowBlockedMetaSchema } from "@zcode/shared/zcode-protocol-v4";
import type { BackgroundResultOriginMeta, DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import type { RuntimeCommand, RuntimeCommandId } from "../src/runtime/command-queue.js";
import { createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  createWorkflowBlockedReminder,
  noteWorkflowReminderCommandStarted,
  noteWorkflowReminderRunEvent,
} from "../src/runtime/methods/dynamic-workflow-blocked-reminder.js";
import { drainRuntimeCommandQueue } from "../src/runtime/methods/runtime-command-queue.js";
import { steerTurn } from "../src/runtime/methods/steering.js";
import {
  WORKFLOW_BLOCKED_REMINDER_DELAYS_MS,
  type WorkflowBlockedReminderClock,
} from "../src/runtime-task/workflow-blocked-reminder.js";
import { formatWorkflowBlockedNotification } from "../src/runtime-task/workflow-notification-copy.js";

const MIN = 60_000;
const [FIRST, SECOND] = WORKFLOW_BLOCKED_REMINDER_DELAYS_MS;

describe("formatWorkflowBlockedNotification", () => {
  const base = {
    runLabel: "nightly audit",
    runId: "dwfrun-1",
    now: 20 * MIN,
    questions: [
      {
        qid: "dwfq-aaaa-1",
        actor: "actor#1@2",
        actorName: "reviewer",
        question: "通过线是 96 还是 95？",
        context: "已经试了 6 轮。",
        askedAt: 3 * MIN,
      },
    ],
    holes: [
      {
        siteId: "hole#21b40fca",
        ordinal: 1,
        name: "修复方案",
        type: "Plan",
        state: "waiting" as const,
        since: 5 * MIN,
        line: 42,
      },
    ],
    draftPath: "/tmp/proj/.zcode/workflow-drafts/audit.dwf.ts",
  };

  it("第 1 次：块里是 run、次数与每个开着的决定；散文给逐字的下一步，并说还有一次", () => {
    const text = formatWorkflowBlockedNotification({ ...base, ordinal: 1, total: 2 });
    assert.match(text, /\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
    assert.match(text, /<workflow-blocked>/);
    assert.match(text, /<run-id>dwfrun-1<\/run-id>/);
    assert.match(text, /<run>nightly audit<\/run>/);
    assert.match(text, /<reminder>1 of 2<\/reminder>/);
    assert.match(text, /<open-questions count="1" shown="1">/);
    assert.match(text, /<question id="dwfq-aaaa-1" subagent="reviewer" waited-ms="1020000">/);
    assert.match(text, /<text>通过线是 96 还是 95？<\/text>/);
    assert.match(text, /<context>已经试了 6 轮。<\/context>/);
    assert.match(text, /<open-holes count="1" shown="1">/);
    assert.match(
      text,
      /<hole id="hole#21b40fca" name="修复方案" type="Plan" line="42" waited-ms="900000"\/>/,
    );
    assert.match(text, /<draft>\/tmp\/proj\/\.zcode\/workflow-drafts\/audit\.dwf\.ts<\/draft>/);
    // 最久的那个决定等了 17 分钟。
    assert.match(
      text,
      /Workflow run nightly audit \(dwfrun-1\) is still waiting on you: 1 question and 1 hole are open, the oldest for 17 minutes, and you have not acted on them since your last turn ended\./,
    );
    assert.match(text, /call ResolveWorkflowQuestion with its id as question_id and your answer/);
    assert.match(text, /call FillWorkflowHole with run_id="dwfrun-1" and its id as hole_id/);
    assert.match(text, /read the draft at \/tmp\/proj\/\.zcode\/workflow-drafts\/audit\.dwf\.ts/);
    assert.match(
      text,
      /If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop\./,
    );
    assert.match(text, /One more reminder follows if nothing changes\./);
    assert.match(text, /nothing times out on their behalf/);
  });

  it("第 2 次：说这是最后一次，以及什么会重新开始", () => {
    const text = formatWorkflowBlockedNotification({ ...base, ordinal: 2, total: 2 });
    assert.match(text, /<reminder>2 of 2<\/reminder>/);
    assert.match(
      text,
      /This is the last reminder: nothing further is sent until the user writes or this run's open decisions change\./,
    );
    assert.doesNotMatch(text, /One more reminder follows/);
  });

  it("只有问题 / 只有留白：另一节整节缺席，下一步也只说在场的那一种", () => {
    const onlyQuestions = formatWorkflowBlockedNotification({
      ...base,
      holes: [],
      ordinal: 1,
      total: 2,
    });
    assert.doesNotMatch(onlyQuestions, /<open-holes/);
    assert.doesNotMatch(onlyQuestions, /FillWorkflowHole/);
    assert.match(onlyQuestions, /1 question is open, for 17 minutes/);

    const onlyHoles = formatWorkflowBlockedNotification({
      ...base,
      questions: [],
      ordinal: 1,
      total: 2,
    });
    assert.doesNotMatch(onlyHoles, /<open-questions/);
    assert.doesNotMatch(onlyHoles, /ResolveWorkflowQuestion/);
    assert.match(onlyHoles, /1 hole is open, for 15 minutes/);
  });

  it("没有草稿路径：让模型用 GetWorkflowRun 取留白的上下文", () => {
    const text = formatWorkflowBlockedNotification({
      ...base,
      draftPath: undefined,
      ordinal: 1,
      total: 2,
    });
    assert.doesNotMatch(text, /<draft>/);
    assert.match(text, /read the run's script with GetWorkflowRun \(run_id="dwfrun-1"\)/);
  });

  it("匿名子代理用结构化引用；标记字符被转义", () => {
    const text = formatWorkflowBlockedNotification({
      ...base,
      runLabel: "a <b> & c",
      questions: [{ qid: "q-1", actor: "actor#3@1", question: 'x < y && "z"', askedAt: 0 }],
      holes: [],
      ordinal: 1,
      total: 2,
    });
    assert.match(text, /<run>a &lt;b&gt; &amp; c<\/run>/);
    assert.match(text, /subagent="actor#3@1"/);
    assert.match(text, /<text>x &lt; y &amp;&amp; &quot;z&quot;<\/text>/);
  });

  it("截断诚实：至多列 8 个问题与 8 处留白，count 说真数；长文本截到 2000 字符", () => {
    const questions = Array.from({ length: 11 }, (_, index) => ({
      qid: `q-${index}`,
      actor: "actor#1@1",
      question: index === 0 ? "长".repeat(5_000) : `问题 ${index}`,
      askedAt: 0,
    }));
    const holes = Array.from({ length: 9 }, (_, index) => ({
      siteId: `hole#${index}`,
      ordinal: 1,
      name: `留白 ${index}`,
      type: "T",
      state: "waiting" as const,
      since: 0,
    }));
    const text = formatWorkflowBlockedNotification({
      ...base,
      questions,
      holes,
      ordinal: 1,
      total: 2,
    });
    assert.match(text, /<open-questions count="11" shown="8">/);
    assert.match(text, /<open-holes count="9" shown="8">/);
    assert.doesNotMatch(text, /id="q-8"/);
    assert.doesNotMatch(text, /id="hole#8"/);
    assert.match(text, new RegExp(`<text>${"长".repeat(1_999)}…</text>`));
    assert.match(text, /11 questions and 9 holes are open/);
    assert.match(text, /GetWorkflowRun lists the ones not shown here/);
  });
});

// ————————————————————————————————————————————————
// runtime 宿主
// ————————————————————————————————————————————————

interface Captured {
  text: string;
  taskId?: string;
  originMeta?: BackgroundResultOriginMeta;
}

const OPEN_SNAPSHOT: Partial<DynamicWorkflowRunSnapshot> = {
  pendingQuestions: [
    { qid: "dwfq-1", actor: "actor#1@1", actorName: "poet", question: "继续吗？", askedAt: 0 },
    { qid: "dwfq-2", actor: "actor#2@1", question: "用哪个分支？", askedAt: 4 * MIN },
  ],
  holes: [
    {
      siteId: "hole#aa",
      ordinal: 1,
      name: "下一步",
      type: "Plan",
      state: "waiting",
      since: 2 * MIN,
    },
    { siteId: "hole#bb", ordinal: 1, name: "已补", type: "Plan", state: "filled", filledAt: MIN },
  ],
  scriptPath: "/tmp/proj/.zcode/workflow-drafts/x.dwf.ts",
};

interface HostRuntime {
  runtime: AgentRuntimeInternal;
  captured: Captured[];
  tasks: Map<string, Record<string, unknown>>;
  readRunIds: string[];
  clock: WorkflowBlockedReminderClock;
}

/** 只给提醒宿主它读的那几样：注册表条目、端口快照、日志与后台通知入口。 */
function hostRuntime(
  snapshots: Map<string, Partial<DynamicWorkflowRunSnapshot> | Error>,
  tasks: Array<[string, Record<string, unknown>]> = [],
): HostRuntime {
  const captured: Captured[] = [];
  const readRunIds: string[] = [];
  const registered = new Map(tasks);
  const runtime = {
    branchGeneration: 0,
    shuttingDown: false,
    hasActiveOrQueuedTurnWork: () => false,
    rootTraceContext: { sessionId: "sess_dwf_blocked", spanId: "span", traceId: "trace" },
    logger: { info: () => {}, warn: () => {} },
    runtimeTaskRegistry: {
      all: () => Object.fromEntries(registered),
      get: (runId: string) => registered.get(runId),
    },
    dynamicWorkflowRunPort: {
      getTask: async (runId: string) => {
        readRunIds.push(runId);
        const snapshot = snapshots.get(runId);
        if (snapshot instanceof Error) throw snapshot;
        return snapshot as DynamicWorkflowRunSnapshot | undefined;
      },
    },
    enqueueBackgroundTaskNotification: (notification: Captured) => {
      captured.push(notification);
    },
  };
  const internal = runtime as unknown as AgentRuntimeInternal;
  const clock = createWorkflowBlockedReminder(internal);
  (internal as { workflowBlockedReminder?: WorkflowBlockedReminderClock }).workflowBlockedReminder =
    clock;
  return { captured, clock, readRunIds, runtime: internal, tasks: registered };
}

function registerRun(tasks: Map<string, Record<string, unknown>>, runId: string): void {
  tasks.set(runId, {
    description: `run ${runId}`,
    status: "running",
    taskId: runId,
    type: "local_dynamic_workflow",
  });
}

/** 提醒唤起的那一轮：忙 → 闲（等价于 drain 首尾两处接线，不真跑回合）。 */
function spendTurn(clock: WorkflowBlockedReminderClock): void {
  clock.sessionBusy();
  clock.sessionIdle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("runtime 上的提醒钟", () => {
  it("空闲 15 分钟：一条 blocked 通知，载荷是计数与最久的等待，taskId 让它继承 run 的分支代", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const tasks = new Map<string, Record<string, unknown>>();
      const host = hostRuntime(new Map([["dwfrun-a", OPEN_SNAPSHOT]]));
      registerRun(tasks, "dwfrun-a");
      for (const [runId, task] of tasks) host.tasks.set(runId, task);
      host.clock.sessionIdle();

      mock.timers.tick(FIRST - 1);
      await settle();
      assert.deepEqual(host.captured, []);
      mock.timers.tick(1);
      await settle();

      assert.equal(host.captured.length, 1);
      assert.equal(host.captured[0]?.taskId, "dwfrun-a");
      const originMeta = host.captured[0]?.originMeta;
      assert.equal(originMeta?.backgroundSource, "workflow");
      assert.equal(originMeta?.workId, "dwfrun-a");
      assert.equal(originMeta?.title, "run dwfrun-a");
      // 补过的留白不算开着；最久的是 askedAt = 0 的那个问题。载荷在它自己的键上，与
      // `workflowNotification` 至多在场一个；shared 运行时 schema 必须认这个键。
      assert.deepEqual(originMeta?.workflowBlocked, {
        questions: 2,
        holes: 1,
        sinceMs: FIRST,
      });
      assert.equal(originMeta?.workflowNotification, undefined);
      assert.equal(workflowBlockedMetaSchema.safeParse(originMeta?.workflowBlocked).success, true);

      const text = host.captured[0]?.text ?? "";
      assert.match(text, /<reminder>1 of 2<\/reminder>/);
      assert.match(text, /<question id="dwfq-1" subagent="poet"/);
      assert.match(text, /<question id="dwfq-2" subagent="actor#2@1"/);
      assert.match(text, /<hole id="hole#aa"/);
      assert.doesNotMatch(text, /hole#bb/);
      assert.match(text, /<draft>\/tmp\/proj\/\.zcode\/workflow-drafts\/x\.dwf\.ts<\/draft>/);
      host.clock.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("没有开着的决定：读过快照，但不发", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const host = hostRuntime(
        new Map([
          [
            "dwfrun-a",
            { holes: [{ siteId: "h", ordinal: 1, name: "n", type: "T", state: "filled" }] },
          ],
        ]),
        [
          [
            "dwfrun-a",
            {
              description: "run a",
              status: "running",
              taskId: "dwfrun-a",
              type: "local_dynamic_workflow",
            },
          ],
        ],
      );
      host.clock.sessionIdle();
      mock.timers.tick(FIRST);
      await settle();
      assert.deepEqual(host.readRunIds, ["dwfrun-a"]);
      assert.deepEqual(host.captured, []);
      host.clock.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("只看在飞的 workflow run：结算了的、别的任务类型、被 rewind 掉的分支都不算", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const host = hostRuntime(
        new Map([
          ["dwfrun-done", OPEN_SNAPSHOT],
          ["bash-1", OPEN_SNAPSHOT],
          ["dwfrun-stale", OPEN_SNAPSHOT],
        ]),
        [
          [
            "dwfrun-done",
            {
              description: "done",
              status: "completed",
              taskId: "dwfrun-done",
              type: "local_dynamic_workflow",
            },
          ],
          [
            "bash-1",
            { description: "bash", status: "running", taskId: "bash-1", type: "local_bash" },
          ],
          [
            "dwfrun-stale",
            {
              branchGeneration: 7,
              description: "stale",
              status: "running",
              taskId: "dwfrun-stale",
              type: "local_dynamic_workflow",
            },
          ],
        ],
      );
      host.clock.sessionIdle();
      mock.timers.tick(SECOND + FIRST);
      await settle();
      assert.deepEqual(host.readRunIds, []);
      assert.deepEqual(host.captured, []);
      host.clock.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("快照读失败只跳过那个 run，不抛、不影响别的 run", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const host = hostRuntime(
        new Map<string, Partial<DynamicWorkflowRunSnapshot> | Error>([
          ["dwfrun-bad", new Error("journal closed")],
          ["dwfrun-ok", OPEN_SNAPSHOT],
        ]),
        [
          [
            "dwfrun-bad",
            {
              description: "bad",
              status: "running",
              taskId: "dwfrun-bad",
              type: "local_dynamic_workflow",
            },
          ],
          [
            "dwfrun-ok",
            {
              description: "ok",
              status: "running",
              taskId: "dwfrun-ok",
              type: "local_dynamic_workflow",
            },
          ],
        ],
      );
      host.clock.sessionIdle();
      mock.timers.tick(FIRST);
      await settle();
      assert.deepEqual(
        host.captured.map((entry) => entry.taskId),
        ["dwfrun-ok"],
      );
      host.clock.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("开集事件（raised / resolved / reached / filled）给该 run 新的一对；其余事件不动次数", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const host = hostRuntime(new Map([["dwfrun-a", OPEN_SNAPSHOT]]), [
        [
          "dwfrun-a",
          {
            description: "a",
            status: "running",
            taskId: "dwfrun-a",
            type: "local_dynamic_workflow",
          },
        ],
      ]);
      const blocked = (): number =>
        host.captured.filter((entry) => entry.originMeta?.workflowBlocked !== undefined).length;
      const runEvent = (eventType: string): void => {
        noteWorkflowReminderRunEvent(host.runtime, {
          eventType,
          payload: {},
          runId: "dwfrun-a",
          sequence: 1,
        });
      };
      host.clock.sessionIdle();
      mock.timers.tick(FIRST);
      await settle();
      spendTurn(host.clock);
      mock.timers.tick(SECOND);
      await settle();
      spendTurn(host.clock);
      assert.equal(blocked(), 2);

      // 与开集无关的事件：不给新的一对，次数仍是耗尽状态。
      runEvent("node-dispatched");
      spendTurn(host.clock);
      mock.timers.tick(SECOND + FIRST);
      await settle();
      assert.equal(blocked(), 2);

      for (const eventType of [
        "escalation-resolved",
        "hole-filled",
        "escalation-raised",
        "hole-reached",
      ]) {
        const before = blocked();
        runEvent(eventType);
        spendTurn(host.clock);
        mock.timers.tick(FIRST);
        await settle();
        assert.equal(blocked(), before + 1, `${eventType} 应当重新给一对提醒`);
        spendTurn(host.clock);
        mock.timers.tick(SECOND);
        await settle();
        assert.equal(blocked(), before + 2, `${eventType} 的第二条`);
        spendTurn(host.clock);
      }
      host.clock.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("beginShutdown 停钟：关会话之后不再唤起任何一轮", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const host = hostRuntime(new Map([["dwfrun-a", OPEN_SNAPSHOT]]), [
        [
          "dwfrun-a",
          {
            description: "a",
            status: "running",
            taskId: "dwfrun-a",
            type: "local_dynamic_workflow",
          },
        ],
      ]);
      host.clock.sessionIdle();
      host.clock.stop();
      mock.timers.tick(SECOND + FIRST);
      await settle();
      assert.deepEqual(host.captured, []);
    } finally {
      mock.timers.reset();
    }
  });
});

// ————————————————————————————————————————————————
// 队列与 steer 上的接线点（忙 / 闲 / 用户发话）
// ————————————————————————————————————————————————

function fakeClock(): { clock: WorkflowBlockedReminderClock; calls: string[] } {
  const calls: string[] = [];
  const clock = {
    openSetChanged: (runId: string) => calls.push(`changed:${runId}`),
    sessionBusy: () => calls.push("busy"),
    sessionIdle: () => calls.push("idle"),
    stop: () => calls.push("stop"),
    userSpoke: () => calls.push("user"),
  } as unknown as WorkflowBlockedReminderClock;
  return { calls, clock };
}

function queueRuntime(clock: WorkflowBlockedReminderClock): AgentRuntimeInternal {
  return {
    activeForegroundExecution: undefined,
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    executeTurnCommand: async () => ({}),
    foregroundPromotionLease: undefined,
    runtimeCommandDrainActive: false,
    runtimeCommandQueue: createRuntimeCommandQueue(),
    workflowBlockedReminder: clock,
  } as unknown as AgentRuntimeInternal;
}

function prompt(id: string, options?: Record<string, unknown>): RuntimeCommand {
  return {
    createdAt: new Date(0),
    id: id as RuntimeCommandId,
    input: id,
    mode: "prompt",
    ...(options ? { options } : {}),
    priority: "next",
    reject: () => {},
    resolve: () => {},
    traceContext: { sessionId: "sess_blocked_queue", spanId: `span_${id}`, traceId: "trace" },
  } as RuntimeCommand;
}

describe("命令队列上的接线", () => {
  it("用户 prompt：忙 + 用户发话，排空后闲", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("hello"));
    await drainRuntimeCommandQueue.call(runtime);
    assert.deepEqual(calls, ["busy", "user", "idle"]);
  });

  it("带合成来源的 prompt 不是用户发话", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("synthetic", { inputSource: "todo_reminder" }));
    await drainRuntimeCommandQueue.call(runtime);
    assert.deepEqual(calls, ["busy", "idle"]);
  });

  it("空排一次队列也报闲（钟自己去重），持着晋升租约时不报", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    await drainRuntimeCommandQueue.call(runtime);
    assert.deepEqual(calls, ["idle"]);

    calls.length = 0;
    runtime.foregroundPromotionLease = { leaseId: "l", promotedInputId: "p" };
    runtime.runtimeCommandQueue.enqueue(prompt("waiting-behind-lease"));
    await drainRuntimeCommandQueue.call(runtime);
    assert.deepEqual(calls, []);
  });

  it("连着两条命令：每条开始都报忙，只在全部排空后报一次闲", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("one"));
    runtime.runtimeCommandQueue.enqueue(prompt("two", { inputSource: "goal-continuation" }));
    await drainRuntimeCommandQueue.call(runtime);
    assert.deepEqual(calls, ["busy", "user", "busy", "idle"]);
  });

  it("合成来源的 prompt 与 task-notification 只报忙、不算用户发话", () => {
    const { clock, calls } = fakeClock();
    const runtime = { workflowBlockedReminder: clock } as unknown as AgentRuntimeInternal;
    noteWorkflowReminderCommandStarted(runtime, prompt("hello"));
    assert.deepEqual(calls, ["busy", "user"]);

    calls.length = 0;
    noteWorkflowReminderCommandStarted(
      runtime,
      prompt("synthetic", { inputSource: "goal_continuation" }),
    );
    noteWorkflowReminderCommandStarted(runtime, {
      branchGeneration: 0,
      createdAt: new Date(0),
      id: "note-1" as RuntimeCommandId,
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "done",
      traceContext: { sessionId: "sess", spanId: "span", traceId: "trace" },
    } as RuntimeCommand);
    assert.deepEqual(calls, ["busy", "busy"]);
  });
});

describe("steer 上的接线", () => {
  function steerRuntime(clock: WorkflowBlockedReminderClock): AgentRuntimeInternal {
    return {
      activeTurn: {
        kind: "regular",
        pendingInputs: [],
        steerable: true,
        traceContext: { sessionId: "sess_blocked_steer", spanId: "span", traceId: "trace" },
        turnId: "turn_1",
      },
      appendEvent: async () => {},
      createPendingInputId: () => "pending_1",
      sessionId: "sess_blocked_steer",
      workflowBlockedReminder: clock,
    } as unknown as AgentRuntimeInternal;
  }

  it("用户 steer 进在跑的一轮：算用户发话", async () => {
    const { clock, calls } = fakeClock();
    const result = await steerTurn.call(steerRuntime(clock), {
      input: "先答那个问题",
      inputPresentation: "user_steer",
    });
    assert.equal(result.kind, "queued");
    assert.deepEqual(calls, ["user"]);
  });

  it("协调者 / 信箱 / 工具跟进的 steer 不是用户发话", async () => {
    const { clock, calls } = fakeClock();
    const runtime = steerRuntime(clock);
    await steerTurn.call(runtime, {
      input: "from coordinator",
      inputPresentation: "coordinator_steer",
    });
    await steerTurn.call(runtime, { delivery: "guide", input: "mailbox" });
    assert.deepEqual(calls, []);
  });
});
