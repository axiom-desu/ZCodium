import { describe, expect, it } from "vitest";
import { buildPluginToolMentionItems } from "@/mentions/providers/pluginsMentionProvider.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";

describe("plugin mentionItems consumer", () => {
  it("maps tool candidates to insertable mention items without rewriting insertText", () => {
    const items = buildPluginToolMentionItems(
      [
        { id: "a", label: "Alpha", insertText: "@alpha:doc-1", description: "Doc 1" },
        { id: "b", label: "Beta", insertText: "@alpha:doc-2", icon: "https://example.test/i.png" },
      ],
      "alpha@zcode-plugins-official",
      "mention_search",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "plugin-tool:alpha@zcode-plugins-official:mention_search:a",
      category: "plugins",
      label: "Alpha",
      markdown: "@alpha:doc-1",
      data: { pluginId: "alpha@zcode-plugins-official" },
    });
    expect(items[1]?.data?.icon).toBe("https://example.test/i.png");
    expect(filterMentionItemsWithOptions(items, "doc-2", { requireQuery: false })).toHaveLength(1);
    // 不同工具的相同候选 id 不互相覆盖。
    const other = buildPluginToolMentionItems(
      [{ id: "a", label: "Alpha", insertText: "@beta:doc-1" }],
      "beta@zcode-plugins-official",
      "search",
    );
    expect(other[0]?.id).not.toBe(items[0]?.id);
  });
});
