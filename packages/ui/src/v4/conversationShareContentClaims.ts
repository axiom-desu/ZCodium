import type { ConversationShareContentBlock } from "@zcode/shared";

import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

/**
 * 「不可呈现」的 workflow 块：快照不可用且没有 run/artifacts 时，服务端只留一句摘要
 * （`assistantText` fallback row）。这种块没有可读卡片，必须把摘要留在原位正文里，
 * 不能既不出卡片、又把 fallback row 藏起来。
 */
function isUnrenderableWorkflowBlock(block: ConversationShareContentBlock): boolean {
  return (
    block.type === "workflow" &&
    Boolean(block.payload.unavailable) &&
    !block.payload.run &&
    block.payload.artifacts.length === 0
  );
}

/**
 * 计算内容块的 fallback 认领关系。
 *
 * 只有真正会画出卡片的块才能认领（隐藏）它的 fallback 摘要行；未知块、不可呈现块、
 * 以及不属于任何已渲染轮次的块都不认领，原位正文因此只出现一次。
 * 轮次归属优先取 turnHeader，缺 header 时退回行本身的 productTurnId，避免「块看起来有
 * 归属、实际哪儿都不画」却提前认领了摘要。
 */
export function resolveConversationShareContentClaims(input: {
  units: readonly ConversationTurnRenderUnit[];
  blocks: readonly ConversationShareContentBlock[];
}): {
  claimedRowIds: ReadonlySet<number>;
  blocksByUnitKey: ReadonlyMap<string, readonly ConversationShareContentBlock[]>;
} {
  const blocksByUnitKey = new Map<string, ConversationShareContentBlock[]>();
  const claimedRowIds = new Set<number>();
  for (const unit of input.units) {
    const productTurnId =
      unit.header?.productTurnId ?? unit.renderRows.find((row) => row.productTurnId)?.productTurnId;
    if (!productTurnId) continue;
    const turnBlocks = input.blocks.filter(
      (block) => block.product_turn_id === productTurnId && !isUnrenderableWorkflowBlock(block),
    );
    if (turnBlocks.length === 0) continue;
    blocksByUnitKey.set(unit.key, turnBlocks);
    for (const block of turnBlocks) {
      // tool-presentation 只给原 toolCall 行补图片/展示，不能把该行的文字输出一起藏掉。
      if (block.type !== "tool-presentation") claimedRowIds.add(block.fallback_row_id);
    }
  }
  return { claimedRowIds, blocksByUnitKey };
}
