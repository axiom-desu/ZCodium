import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkSiteStability,
  collectSites,
  createWorkflowProgram,
  holeSiteId,
  spliceHoleBody,
  type JournalStorePort,
  type OpenHole,
  type RunEvent,
  type StoredEvent,
} from "@zcode/dynamic-workflow";
import type { DynamicWorkflowRunServiceDeps } from "../src/app/dynamic-workflow-run-service.js";
import type { RunRegistryEntry } from "../src/app/dynamic-workflow-run-observation.js";
import { fillDynamicWorkflowHole } from "../src/app/dynamic-workflow-run-fill.js";
import { compiledHolesOf, projectRunHoles, type CompiledHole } from "../src/app/dynamic-workflow-run-holes.js";

/**
 * P2 驱动面（bootstrap）：补全服务的事务边界与留白快照投影。用例只依赖端口实现体与纯合成规则，
 * 不构造整个 run service——引擎侧由 dynamic-workflow 包的测试覆盖。
 */

const OPEN_SCRIPT = 'const x = await hole<string>("decide", "what next");\nreturn x;';
const FILLED_SCRIPT = 'const x = await hole<string>("done", "p", async () => "v");\nreturn x;';

interface FakeControl {
  fillHole(fill: unknown): { ok: true } | { ok: false; reason: string };
  openHoles(): readonly OpenHole[];
}

interface Harness {
  ctx: Parameters<typeof fillDynamicWorkflowHole>[0];
  entry: RunRegistryEntry;
  fillCalls: unknown[];
  openHoles: readonly OpenHole[];
}

function harness(options: {
  runId?: string;
  scriptText?: string;
  scriptPath?: string;
  record?: unknown;
  isLive?: boolean;
  openHoles?: readonly OpenHole[];
}): Harness {
  const runId = options.runId ?? "dwfrun-1";
  const fillCalls: unknown[] = [];
  const openHoles = options.openHoles ?? [];
  const control: FakeControl = {
    fillHole: (fill) => {
      fillCalls.push(fill);
      return { ok: true };
    },
    openHoles: () => openHoles,
  };
  const entry = {
    controller: new AbortController(),
    control,
    startedAt: new Date(0),
    cwd: "/tmp",
    scriptText: options.scriptText ?? OPEN_SCRIPT,
    ...(options.scriptPath === undefined ? {} : { scriptPath: options.scriptPath }),
    terminal: options.isLive === false ? { status: "stopped", reason: "user" } : undefined,
    settlement: Promise.resolve({}),
  } as unknown as RunRegistryEntry;
  const runs = new Map<string, RunRegistryEntry>([[runId, entry]]);
  const journal = {
    getRun: () => options.record,
  } as unknown as JournalStorePort;
  const deps = {
    journal,
    parentSessionId: "session-1",
    logger: undefined,
  } as unknown as DynamicWorkflowRunServiceDeps;
  return {
    ctx: { deps, runs, fillQueues: new Map() },
    entry,
    fillCalls,
    openHoles,
  };
}

describe("fillDynamicWorkflowHole — 成功路径", () => {
  it("拼接 + 编译 + 稳定性校验通过后把有效脚本写回注册表条目，并放行引擎", async () => {
    const h = harness({});
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "dwfrun-1",
      holeId: holeSiteId("decide"),
      body: 'return "ok";',
      parentSessionId: "session-1",
      trace: {} as never,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.scriptText, /async \(\) => \{\n  return "ok";\n\}/);
    assert.equal(result.scriptText, h.entry.scriptText);
    // 引擎收到的是有效脚本 lowering 出的函数体文本，而不是模型手写的源码。
    assert.equal(h.fillCalls.length, 1);
    const fill = h.fillCalls[0] as { siteId: string; code: string; script: { text: string } };
    assert.equal(fill.siteId, holeSiteId("decide"));
    assert.match(fill.code, /return "ok"/);
    assert.equal(fill.script.text, result.scriptText);
    // 事实表跟着换：这处留白不再开放。
    assert.equal(h.entry.holes?.find((hole) => hole.siteId === holeSiteId("decide"))?.open, false);
  });
});

describe("fillDynamicWorkflowHole — 拒绝即零副作用", () => {
  it("run_not_found：journal 与注册表都没有它", async () => {
    const h = harness({});
    h.ctx.runs.clear();
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "missing",
      holeId: holeSiteId("decide"),
      body: "return 1;",
      trace: {} as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "run_not_found");
  });

  it("hole_not_waiting：未知的站点 id（还没到达）", async () => {
    const h = harness({});
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "dwfrun-1",
      holeId: "hole#00000000",
      body: "return 1;",
      trace: {} as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "hole_not_waiting");
    assert.equal(h.fillCalls.length, 0);
  });

  it("hole_not_waiting：留白已经有函数体（已补）", async () => {
    const h = harness({ scriptText: FILLED_SCRIPT });
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "dwfrun-1",
      holeId: holeSiteId("done"),
      body: "return 1;",
      trace: {} as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "hole_not_waiting");
    assert.match(result.ok ? "" : result.message, /already filled/);
    assert.equal(h.fillCalls.length, 0);
  });

  it("hole_not_waiting：run 不在本进程飞", async () => {
    const h = harness({ isLive: false, record: { status: "stopped" } });
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "dwfrun-1",
      holeId: holeSiteId("decide"),
      body: "return 1;",
      trace: {} as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "hole_not_waiting");
    assert.match(result.ok ? "" : result.message, /stopped/);
  });

  it("compile_failed：函数体类型不符时带 diagnostics，草稿不动、引擎不被调用", async () => {
    const h = harness({ scriptPath: "/tmp/dwf-script.ts" });
    const before = h.entry.scriptText;
    const result = await fillDynamicWorkflowHole(h.ctx, {
      runId: "dwfrun-1",
      holeId: holeSiteId("decide"),
      body: "return 42;",
      trace: {} as never,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "compile_failed");
    assert.ok((result.diagnostics?.length ?? 0) > 0);
    // 草稿（注册表条目上的有效脚本）与引擎都没动。
    assert.equal(h.entry.scriptText, before);
    assert.equal(h.fillCalls.length, 0);
  });
});

describe("checkSiteStability — fill_ids_unstable 判据", () => {
  // 服务层的这一支只在分析器给既有站点换了号（宿主故障）时可达；这里直接钉住稳定性复核本身，
  // 因为用合法脚本与合法拼接无法在服务层构造出换号。
  it("站点行号平移数与插入行数不符时报宿主故障", () => {
    const script = [
      "const x = await hole<string>(",
      '  "shift",',
      "  `p`,",
      ");",
      'const w = agent("worker");',
      "return x;",
    ].join("\n");
    const before = collectSites(createWorkflowProgram(script));
    const id = holeSiteId("shift");
    const spliced = spliceHoleBody(script, before, id, "return 1;");
    assert.ok(spliced);
    const after = collectSites(createWorkflowProgram(spliced.text));
    const stability = checkSiteStability(
      before,
      after,
      id,
      spliced.insertedAtLine,
      spliced.insertedLines + 1,
    );
    assert.equal(stability.ok, false);
    assert.match(stability.ok ? "" : stability.detail, /moved from/);
  });
});

describe("projectRunHoles — 快照 holes[] 投影", () => {
  const compiled: CompiledHole[] = [
    { siteId: "hole#aaaa", name: "decide", type: "string", line: 3, open: true },
    { siteId: "hole#bbbb", name: "second", type: "number", line: 9, open: false },
  ];

  function stored(sequence: number, event: RunEvent, timeCreated?: number): StoredEvent {
    return { sequence, event, ...(timeCreated === undefined ? {} : { timeCreated }) };
  }

  it("waiting 与 filled 两态：waiting 来自引擎停驻表、filled 来自 hole-filled 事件", () => {
    const reached = (siteId: string, ordinal: number, name: string): StoredEvent =>
      stored(
        0,
        { type: "hole-reached", instance: { siteId, ordinal }, name },
        ordinal * 10,
      );
    const events = [
      stored(0, { type: "run-launched", inputId: "t", phaseNames: ["decide", "second"] }),
      reached("hole#aaaa", 1, "decide"),
      reached("hole#bbbb", 1, "second"),
      stored(3, {
        type: "hole-filled",
        siteId: "hole#bbbb",
        filledAt: 999,
        filledBy: "session-1",
        phaseNames: ["decide"],
      }),
    ];
    const holes = projectRunHoles({
      events,
      openHoles: [{ siteId: "hole#aaaa", ordinal: 1, name: "decide", since: 10 }],
      holes: compiled,
      phaseNames: ["decide", "second"],
    });

    assert.equal(holes.length, 2);
    const waiting = holes.find((hole) => hole.siteId === "hole#aaaa");
    const filled = holes.find((hole) => hole.siteId === "hole#bbbb");
    assert.equal(waiting?.state, "waiting");
    assert.equal(waiting?.since, 10);
    assert.equal(waiting?.type, "string");
    assert.equal(filled?.state, "filled");
    assert.equal(filled?.filledAt, 999);
    assert.equal(filled?.filledBy, "session-1");
    // before / after 来自阶段表：decide 之后是 second。
    assert.equal(waiting?.after, "second");
  });

  it("上界 32 条：超出的到达不再进快照", () => {
    const events: StoredEvent[] = [
      stored(0, { type: "run-launched", inputId: "t" }),
    ];
    for (let i = 0; i < 40; i += 1) {
      events.push(
        stored(i + 1, {
          type: "hole-reached",
          instance: { siteId: "hole#aaaa", ordinal: i + 1 },
          name: "decide",
        }),
      );
    }
    const openHoles: OpenHole[] = [];
    for (let i = 0; i < 40; i += 1) {
      openHoles.push({ siteId: "hole#aaaa", ordinal: i + 1, name: "decide", since: i });
    }
    const holes = projectRunHoles({
      events,
      openHoles,
      holes: compiled,
      phaseNames: undefined,
    });
    assert.equal(holes.length, 32);
  });
});

describe("compiledHolesOf", () => {
  it("抄下站点 id、字面名、类型原文、行号与开放与否", () => {
    const table = collectSites(createWorkflowProgram(OPEN_SCRIPT));
    const holes = compiledHolesOf(table);
    assert.equal(holes.length, 1);
    assert.deepEqual(holes[0], {
      siteId: holeSiteId("decide"),
      name: "decide",
      type: "string",
      line: 1,
      open: true,
    });
  });
});
