import { describe, expect, it } from "vitest";
import type { ConversationRow, ToolCallRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveLogicalUiInstances,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "./pluginUiInstancePolicy.js";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

// 优化前的算法作为测试 oracle：刻意保留 includes、slice、引用比较和覆盖顺序，
// 防止性能改动顺手改变重复 ID、特殊窗口参数或跨回合替代语义。
function reference(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  const turnOrder: string[] = [];
  for (const row of rows) {
    if (!turnOrder.includes(row.turnId)) turnOrder.push(row.turnId);
  }
  const recent = turnOrder.slice(-(options.autoExpandTurns ?? 3));
  const keys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of rows) {
    if (row.kind !== "toolCall" || row.display?.kind !== "mcp_tool" || !row.display.ui) continue;
    const display = row.display;
    const key = JSON.stringify([
      display.ui!.pluginId,
      display.serverName,
      display.ui!.resourceUri,
      resolvePluginUiLogicalScope(display.ui!, { kind: "toolCall", toolCallId: row.toolCallId }),
    ]);
    if (groups[key]) groups[key]!.push(row);
    else {
      groups[key] = [row];
      keys.push(key);
    }
  }
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  const result: PluginUiInstanceDerivation = { instances: [], byToolCallId };
  for (const key of keys) {
    const group = groups[key]!;
    const successful = group.filter(
      (row) =>
        row.status === "success" &&
        !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true),
    );
    const active = successful.at(-1) ?? group.at(-1)!;
    const superseded = successful.filter((row) => row !== active).map((row) => row.toolCallId);
    result.instances.push({
      key,
      activeToolCallId: active.toolCallId,
      supersededToolCallIds: superseded,
    });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: superseded.includes(row.toolCallId),
        autoExpand: recent.includes(row.turnId),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return result;
}

function user(turnId: string, rowId = 0): UserInputRow {
  return {
    kind: "userInput",
    turnId,
    rowId,
    createdAt: rowId,
    createdAtSeq: rowId,
    origin: "realUser",
    text: "fixture",
  };
}

function tool(
  id: number,
  options: {
    turnId?: string;
    toolCallId?: string;
    status?: ToolCallRow["status"];
    isError?: boolean;
    surface?: string | false;
    widgetMeta?: string;
    csp?: { connectDomains?: string[]; resourceDomains?: string[] };
    serverName?: string;
    resourceUri?: string;
    showInline?: true;
  } = {},
): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    createdAt: id,
    createdAtSeq: id,
    turnId: options.turnId ?? `turn-${id}`,
    toolCallId: options.toolCallId ?? `call-${id}`,
    toolName: "mcp__fixture__edit",
    status: options.status ?? "success",
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: options.serverName ?? "fixture",
      toolName: "edit",
      ui: {
        pluginId: "fixture",
        resourceUri: options.resourceUri ?? "ui://fixture",
        ...(options.surface === false ? {} : { surface: options.surface ?? "panel" }),
        ...(options.widgetMeta ? { widgetMeta: options.widgetMeta } : {}),
        ...(options.csp ? { csp: options.csp } : {}),
        ...(options.isError ? { isError: true as const } : {}),
        ...(options.showInline ? { showInline: true as const } : {}),
      },
    },
  };
}

function check(rows: readonly ConversationRow[], options: { autoExpandTurns?: number } = {}) {
  const result = deriveLogicalUiInstances(rows, options);
  expect(result).toEqual(reference(rows, options));
  return result;
}

describe("linear plugin UI instance derivation", () => {
  it("returns fresh empty results without a turn directory for non-plugin histories", () => {
    let turnReads = 0;
    const row = user("unused");
    Object.defineProperty(row, "turnId", {
      get: () => {
        turnReads++;
        return "unused";
      },
    });
    const first = deriveLogicalUiInstances([row]);
    const second = deriveLogicalUiInstances([row]);
    expect(first).toEqual({ instances: [], byToolCallId: {} });
    expect(second).not.toBe(first);
    expect(second.instances).not.toBe(first.instances);
    expect(second.byToolCallId).not.toBe(first.byToolCallId);
    // 没有插件时无需读回合身份；用确定性访问计数防止退回完整目录构造，而不是计时断言。
    expect(turnReads).toBe(0);
    check([]);
  });

  it("ignores ordinary tools, MCP results without UI and non-MCP displays", () => {
    const ordinary: ToolCallRow = { ...tool(1), display: undefined };
    const mcp: ToolCallRow = {
      ...tool(2),
      display: { kind: "mcp_tool", serverName: "fixture", toolName: "edit" },
    };
    const screenshot: ToolCallRow = {
      ...tool(3),
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    };
    expect(check([ordinary, mcp, screenshot])).toEqual({ instances: [], byToolCallId: {} });
  });

  it("counts all turns in first-seen order, including numeric and non-contiguous IDs", () => {
    const rows = [
      tool(1, { turnId: "10" }),
      user("2"),
      user("1"),
      user("0"),
      tool(2, { turnId: "10" }),
    ];
    const result = check(rows);
    expect(result.byToolCallId["call-2"]?.autoExpand).toBe(false);
    expect(check(rows, { autoExpandTurns: 4 }).byToolCallId["call-2"]?.autoExpand).toBe(true);
  });

  it("only successful non-isError rows supersede earlier successful results", () => {
    const rows = [
      tool(1),
      tool(2, { status: "running" }),
      tool(3, { isError: true }),
      tool(4, { status: "error" }),
      tool(5, { showInline: true }),
      tool(6, { status: "cancelled" }),
    ];
    const result = check(rows);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.activeToolCallId).toBe("call-5");
    expect(result.instances[0]?.supersededToolCallIds).toEqual(["call-1"]);
    expect(Object.values(result.byToolCallId).map((entry) => entry.superseded)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(result.byToolCallId["call-5"]?.forcedInline).toBe(true);
  });

  it("falls back to the last row when no successful call exists", () => {
    const result = check([
      tool(1, { status: "error" }),
      tool(2, { isError: true }),
      tool(3, { status: "cancelled" }),
    ]);
    expect(result.instances[0]?.activeToolCallId).toBe("call-3");
    expect(result.instances[0]?.supersededToolCallIds).toEqual([]);
  });

  it("retains group order and separates ordinary calls, servers and resources", () => {
    const result = check([
      tool(1, { surface: false }),
      tool(2, { surface: false }),
      tool(3, { serverName: "other" }),
      tool(4, { resourceUri: "ui://other" }),
      tool(5),
      tool(6, { serverName: "other" }),
    ]);
    expect(result.instances.map((entry) => entry.activeToolCallId)).toEqual([
      "call-1",
      "call-2",
      "call-6",
      "call-4",
      "call-5",
    ]);
  });

  it("shares explicit widgets only with matching sorted permission scopes", () => {
    const widgetMeta = JSON.stringify({ "openai/widgetSessionId": "counter" });
    const result = check([
      tool(1, {
        surface: false,
        widgetMeta,
        csp: {
          connectDomains: ["https://b.invalid", "https://a.invalid"],
          resourceDomains: ["https://c.invalid"],
        },
      }),
      tool(2, {
        surface: false,
        widgetMeta,
        csp: {
          resourceDomains: ["https://c.invalid"],
          connectDomains: ["https://a.invalid", "https://b.invalid"],
        },
      }),
      tool(3, {
        surface: false,
        widgetMeta,
        csp: { connectDomains: ["https://different.invalid"] },
      }),
      tool(4, { surface: false, widgetMeta: "invalid" }),
    ]);
    expect(result.instances.map((entry) => entry.activeToolCallId)).toEqual([
      "call-2",
      "call-3",
      "call-4",
    ]);
  });

  it.each([0, -0, -1, -3, 1.5, -1.5, Infinity, -Infinity, NaN, 10000])(
    "preserves slice semantics for autoExpandTurns=%s",
    (autoExpandTurns) => {
      check([tool(1), user("no-ui"), tool(2), tool(3), tool(4)], { autoExpandTurns });
    },
  );

  it("does not confuse inherited property names with seen or superseded IDs", () => {
    const rows = [
      tool(1, { turnId: "__proto__", toolCallId: "constructor" }),
      user("toString"),
      tool(2, { turnId: "constructor", toolCallId: "toString" }),
      user("hasOwnProperty"),
      tool(3, { turnId: "valueOf", toolCallId: "valueOf" }),
      tool(4, { turnId: "__proto__", toolCallId: "__proto__" }),
    ];
    const result = check(rows, { autoExpandTurns: 1 });
    expect(result.byToolCallId["constructor"]?.autoExpand).toBe(false);
    expect(result.byToolCallId["valueOf"]?.autoExpand).toBe(true);
    // 返回 record 的既有构造未在性能 PR 中改变，包括 __proto__ 的特殊赋值语义。
    expect(Object.getPrototypeOf(result.byToolCallId)).toEqual(
      Object.getPrototypeOf(reference(rows).byToolCallId),
    );
  });

  it("preserves ID-based supersession, duplicate IDs and group-order overwrite", () => {
    const repeated = tool(1, { toolCallId: "same" });
    check([repeated, repeated]);
    const result = check([repeated, tool(2, { toolCallId: "same" }), tool(3)]);
    expect(result.instances[0]?.supersededToolCallIds).toEqual(["same", "same"]);
    check([
      repeated,
      tool(4, { toolCallId: "same", surface: "other" }),
      tool(5, { toolCallId: "same" }),
    ]);
  });

  it("does not mutate input rows, metadata, or previously published derivations", () => {
    const rows = [tool(1), user("no-ui"), tool(2)];
    for (const row of rows) {
      if (row.kind === "toolCall" && row.display?.kind === "mcp_tool") {
        Object.freeze(row.display.ui);
        Object.freeze(row.display);
      }
      Object.freeze(row);
    }
    Object.freeze(rows);
    const before = check(rows);
    const saved = structuredClone(before);
    Object.freeze(before.instances[0]?.supersededToolCallIds);
    Object.freeze(before.instances[0]);
    Object.freeze(before.instances);
    Object.freeze(before.byToolCallId);
    Object.freeze(before);
    check([...rows, tool(3)]);
    expect(before).toEqual(saved);
  });

  it("matches the reference across seeded live deltas and replayable snapshots", () => {
    let seed = 42;
    let id = 4;
    let rows: ConversationRow[] = [tool(1), user("no-ui"), tool(2), tool(3, { status: "running" })];
    for (let step = 0; step < 160; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      switch (seed % 5) {
        case 0:
          rows = [...rows, tool(id++, { surface: id % 2 ? "panel" : false })];
          break;
        case 1:
          rows = rows.map((row) =>
            row.kind === "toolCall" && row === rows.at(-1)
              ? { ...row, status: "success", inputText: row.inputText + " delta" }
              : row,
          );
          break;
        case 2:
          rows = rows.map((row) => ({ ...row }));
          break;
        case 3:
          rows = rows.slice(1);
          break;
        case 4:
          rows = [user(`older-${step}`), ...rows];
          break;
      }
      check(rows, { autoExpandTurns: step % 7 });
    }
  });
});
