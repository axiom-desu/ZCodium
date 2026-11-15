import assert from "node:assert/strict";
import { test } from "node:test";
import { requestPluginMentionItems } from "#src/zcode-agent/pluginMentionItemsClient.js";

const params = {
  workspacePath: "/tmp/a7-mention",
  sessionId: "sess-1",
  pluginId: "alpha@zcode-plugins-official",
  tool: "mention_search",
  query: "doc",
};

test("mentionItems 客户端只发严格线格式并映射 supported 结果", async () => {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const result = await requestPluginMentionItems(
    {
      async request(method, input, _schema, options) {
        calls.push({ method, params: input, options });
        return { items: [{ id: "a", label: "A", insertText: "@a" }] };
      },
    },
    params,
  );
  assert.deepEqual(result, {
    supported: true,
    items: [{ id: "a", label: "A", insertText: "@a" }],
  });
  assert.deepEqual(calls, [
    {
      method: "plugins/mentionItems",
      params: {
        sessionId: "sess-1",
        pluginId: "alpha@zcode-plugins-official",
        tool: "mention_search",
        query: "doc",
      },
      // 首次调用可能在会话里等审批：观察态超时不能回收 workspace CLI。
      options: { lifecycle: "observation", timeoutMs: 10 * 60_000 },
    },
  ]);
});

test("旧 CLI 的 -32601 是能力缺失而不是失败", async () => {
  const result = await requestPluginMentionItems(
    {
      async request() {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    },
    params,
  );
  assert.deepEqual(result, { supported: false });
});

test("授权拒绝/工具失败保持错误，不能被当成 supported", async () => {
  await assert.rejects(
    requestPluginMentionItems(
      {
        async request() {
          throw Object.assign(new Error("denied"), {
            code: -32000,
            data: { code: "plugin_mention_tool_denied" },
          });
        },
      },
      params,
    ),
    /denied/u,
  );
});
