import { expect, test } from "vitest";

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import {
  aggregateConversationShareBlockingIssues,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import {
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedRowIds,
  useConversationShareSelectionStore,
} from "@/store/conversationShareSelectionStore.js";

const base = { turnId: "turn-1", productTurnId: "product-turn-1", createdAt: 1 } as const;

function rows(display?: unknown): ConversationRow[] {
  return [
    {
      ...base,
      rowId: 1,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    } as ConversationRow,
    {
      ...base,
      rowId: 2,
      createdAtSeq: 2,
      kind: "assistantText",
      state: "complete",
      text: "answer",
    } as ConversationRow,
    {
      ...base,
      rowId: 3,
      createdAtSeq: 3,
      kind: "toolCall",
      toolCallId: "tool-1",
      toolName: "node_repl",
      status: "success",
      inputText: "shot()",
      ...(display === undefined ? {} : { display }),
    } as ConversationRow,
  ];
}

const scope = {
  workspaceKey: "/workspace-a",
  remoteSessionId: "remote-1",
  sessionId: "session-1",
  revision: 7,
  logEpoch: "epoch-1",
  capabilitiesFingerprint: "caps-1",
};

test("preflight fingerprint follows content, scope and revision", () => {
  const plain = conversationShareTurnFingerprint(rows(), "product-turn-1", "/workspace-a", scope);
  expect(conversationShareTurnFingerprint(rows(), "product-turn-1", "/workspace-a", scope)).toBe(
    plain,
  );

  const withImages = conversationShareTurnFingerprint(
    rows({ kind: "node_repl_images", images: [{ base64: "AAAA", mimeType: "image/png" }] }),
    "product-turn-1",
    "/workspace-a",
    scope,
  );
  // 内嵌图片改变分享载荷：不能让旧预检结果继续命中。
  expect(withImages).not.toBe(plain);

  for (const changed of [
    { ...scope, workspaceKey: "/workspace-b" },
    { ...scope, remoteSessionId: "remote-2" },
    { ...scope, sessionId: "session-2" },
    { ...scope, revision: 8 },
    { ...scope, logEpoch: "epoch-2" },
    { ...scope, capabilitiesFingerprint: "caps-2" },
  ]) {
    expect(
      conversationShareTurnFingerprint(rows(), "product-turn-1", "/workspace-a", changed),
    ).not.toBe(plain);
  }
});

test("stale fingerprints force a fresh preflight for exactly the changed turns", () => {
  const key = conversationSharePreflightCacheKey("scope-key", "product-turn-1");
  const cache = new Map([
    [
      key,
      {
        productTurnId: "product-turn-1",
        turnFingerprint: "old",
        blockingIssues: [],
        skippableWarnings: [],
        deferredIssues: [],
      },
    ],
  ]);
  expect(
    getMissingConversationSharePreflightTurnIds(
      "scope-key",
      ["product-turn-1"],
      cache,
      new Map([["product-turn-1", "new"]]),
    ),
  ).toEqual(["product-turn-1"]);
  expect(
    getMissingConversationSharePreflightTurnIds(
      "scope-key",
      ["product-turn-1"],
      cache,
      new Map([["product-turn-1", "old"]]),
    ),
  ).toEqual([]);
  // 换了 workspace/session 就等于换了 scope key：旧缓存里的条目不再命中。
  expect(
    getMissingConversationSharePreflightTurnIds("other-scope", ["product-turn-1"], cache),
  ).toEqual(["product-turn-1"]);
});

test("row budget is recomputed for the current selection instead of summed batches", () => {
  const entries = [
    {
      productTurnId: "t1",
      rowBudget: { count: 5, limit: 8 },
      blockingIssues: [],
      skippableWarnings: [],
      deferredIssues: [],
    },
    {
      productTurnId: "t2",
      rowBudget: { count: 5, limit: 8 },
      blockingIssues: [],
      skippableWarnings: [],
      deferredIssues: [],
    },
  ];
  const issues = aggregateConversationShareBlockingIssues(entries);
  expect(issues).toEqual([{ code: "rows_limit", scope: "conversation", actual: 10, limit: 8 }]);

  // 取消一轮后重新聚合：问题随之消失，不需要重新 RPC。
  expect(aggregateConversationShareBlockingIssues(entries.slice(0, 1))).toEqual([]);
  // 老 host 没有 rowBudget：退回逐条去重，不凭空判定超限。
  expect(
    aggregateConversationShareBlockingIssues([
      { ...entries[0]!, rowBudget: undefined },
      { ...entries[1]!, rowBudget: undefined },
    ]),
  ).toEqual([]);
});

test("selection cancel keeps the draft scope until finish and retries stay idempotent", () => {
  const store = useConversationShareSelectionStore.getState();
  store.resetForTests();
  store.setScope("task-1", "partial");
  store.syncAvailableTurns("task-1", [
    { rowId: 1, productTurnId: "t1" },
    { rowId: 2, productTurnId: "t1" },
    { rowId: 3, productTurnId: "t2" },
  ]);
  store.toggleRow("task-1", 1);
  expect(
    getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-1"),
  ).toEqual([2, 3]);
  // 整轮取消幂等：重复调用不改变状态，也不影响其它轮。
  store.deselectProductTurn("task-1", "t1");
  const afterDeselect = useConversationShareSelectionStore.getState();
  store.deselectProductTurn("task-1", "t1");
  expect(
    getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-1"),
  ).toEqual([3]);
  expect(getConversationShareSelectedRowIds(afterDeselect, "task-1")).toEqual([3]);
  // 「取消」返回「全部对话」时草稿清空，但同一 session 的重试 attempt 保留。
  store.updateDockState("task-1", {
    attempt: { key: "k", clientRequestId: "req-1" },
    publishing: true,
    progress: "packing",
  });
  store.finishSelection("task-1");
  const finished = useConversationShareSelectionStore.getState();
  const dock = getConversationShareDockState(finished, "task-1");
  expect(dock.publishing).toBe(false);
  expect(dock.progress).toBe(DEFAULT_CONVERSATION_SHARE_DOCK_STATE.progress);
  expect(dock.attempt).toEqual({ key: "k", clientRequestId: "req-1" });
  expect(getConversationShareSelectedRowIds(finished, "task-1")).toEqual([]);
});
