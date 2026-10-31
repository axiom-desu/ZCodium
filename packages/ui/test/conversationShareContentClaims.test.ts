import { conversationShareContentBlockSchema, type ConversationRow } from "@zcode/shared";
import { describe, expect, it } from "vitest";

import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { resolveConversationShareContentClaims } from "@/v4/conversationShareContentClaims.js";

const base = {
  turnId: "turn-1",
  productTurnId: "share-product-turn-1",
  createdAt: 1,
} as const;

function rows(options: { withHeader?: boolean; productTurnId?: string } = {}): ConversationRow[] {
  const productTurnId = options.productTurnId ?? base.productTurnId;
  return [
    ...(options.withHeader === false
      ? []
      : [
          {
            ...base,
            productTurnId,
            rowId: 1,
            createdAtSeq: 1,
            kind: "turnHeader",
            origin: "userInput",
            state: "completedSuccess",
            startedAt: 1,
          } as ConversationRow,
        ]),
    {
      ...base,
      productTurnId,
      rowId: 2,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      text: "hello",
      clientId: "client-1",
    } as ConversationRow,
    {
      ...base,
      productTurnId,
      rowId: 3,
      createdAtSeq: 3,
      kind: "assistantText",
      state: "complete",
      text: "Weekly\n\nWorkflow · unavailable\n\nWorkflow snapshot unavailable",
    } as ConversationRow,
  ];
}

function workflowBlock(overrides: Record<string, unknown> = {}, options: { version?: 1 | 2 } = {}) {
  return conversationShareContentBlockSchema.parse({
    id: "share-content-1",
    type: "workflow",
    version: options.version ?? 2,
    product_turn_id: "share-product-turn-1",
    fallback_row_id: 3,
    captured_at: 1,
    resource_ids: [],
    payload: { name: "Weekly", completion: true, artifacts: [] },
    ...overrides,
  });
}

function units(source: ConversationRow[] = rows()) {
  return buildConversationTurnRenderUnits(source);
}

describe("conversation share content claims", () => {
  it("claims the fallback row only for a workflow card that actually renders", () => {
    const result = resolveConversationShareContentClaims({
      units: units(),
      blocks: [workflowBlock()],
    });
    expect([...result.claimedRowIds]).toEqual([3]);
    expect(result.blocksByUnitKey.get("turn-1")).toHaveLength(1);
  });

  it("keeps the readable summary when an unavailable workflow has no run or artifacts", () => {
    // 服务端在 run 读不到时只合成 assistantText 摘要 + `unavailable` 块；块没有可读卡片，
    // 因此不得认领 fallback row，否则公开页与导入副本会同时丢掉唯一一句摘要。
    const result = resolveConversationShareContentClaims({
      units: units(),
      blocks: [
        workflowBlock({
          payload: {
            name: "Weekly",
            completion: false,
            artifacts: [],
            unavailable: "source_unavailable",
          },
        }),
      ],
    });
    expect([...result.claimedRowIds]).toEqual([]);
    expect(result.blocksByUnitKey.size).toBe(0);
  });

  it("does not claim the tool output row for tool-presentation blocks", () => {
    const block = conversationShareContentBlockSchema.parse({
      id: "share-content-2",
      type: "tool-presentation",
      version: 1,
      product_turn_id: "share-product-turn-1",
      fallback_row_id: 3,
      captured_at: 1,
      resource_ids: ["share-artifact-1"],
      payload: {
        display: { kind: "bash_output", output: "$ npm test", truncated: false },
        images: [{ resource_id: "share-artifact-1", mime_type: "image/png" }],
      },
    });
    const result = resolveConversationShareContentClaims({
      units: units(),
      blocks: [block],
    });
    expect([...result.claimedRowIds]).toEqual([]);
    expect(result.blocksByUnitKey.get("turn-1")).toEqual([block]);
  });

  it("keeps the fallback row when the block has no rendered unit", () => {
    const result = resolveConversationShareContentClaims({
      units: units(),
      blocks: [workflowBlock({ product_turn_id: "share-product-turn-9" })],
    });
    expect([...result.claimedRowIds]).toEqual([]);
    expect(result.blocksByUnitKey.size).toBe(0);
  });

  it("renders and claims on turns without a turnHeader by deriving the product turn from rows", () => {
    const result = resolveConversationShareContentClaims({
      units: units(rows({ withHeader: false })),
      blocks: [workflowBlock()],
    });
    expect([...result.claimedRowIds]).toEqual([3]);
    expect(result.blocksByUnitKey.get("turn-1")).toHaveLength(1);
  });

  it("keeps v1 workflow blocks claimed so the card replaces the summary as before", () => {
    const result = resolveConversationShareContentClaims({
      units: units(),
      blocks: [workflowBlock({}, { version: 1 })],
    });
    expect([...result.claimedRowIds]).toEqual([3]);
    expect(result.blocksByUnitKey.get("turn-1")).toHaveLength(1);
  });

  it("claims nothing for v1 archives that carry no content blocks", () => {
    const result = resolveConversationShareContentClaims({ units: units(), blocks: [] });
    expect([...result.claimedRowIds]).toEqual([]);
    expect(result.blocksByUnitKey.size).toBe(0);
  });
});
