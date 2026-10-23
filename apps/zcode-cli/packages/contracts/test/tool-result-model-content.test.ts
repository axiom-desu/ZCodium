// S6：completed/error metadata.modelContent 必须兼容旧字符串与严格引用数组；
// 单条 modelContent 损坏不能丢弃 display/media 布局等其余 metadata。
import assert from "node:assert/strict";
import { it } from "node:test";

import { parseCompletedToolPartMetadata } from "../src/tools/tool-result-metadata.js";

const display = { kind: "mcp_tool", serverName: "server", toolName: "tool" } as const;

it("接受 error 字符串与严格 text/reference 数组", () => {
  assert.deepEqual(
    parseCompletedToolPartMetadata({
      schemaVersion: 1,
      modelContent: "provider error",
      display,
    }),
    { schemaVersion: 1, modelContent: "provider error", display },
  );
  const content = [
    { type: "text", text: "loaded" },
    { type: "tool_reference", toolName: "TodoWrite" },
  ] as const;
  assert.deepEqual(
    parseCompletedToolPartMetadata({ schemaVersion: 1, modelContent: content, display }),
    { schemaVersion: 1, modelContent: content, display },
  );
});

it("损坏的 modelContent 只丢该字段，保留 display", () => {
  assert.deepEqual(
    parseCompletedToolPartMetadata({
      schemaVersion: 1,
      modelContent: [{ type: "tool_reference", toolName: "TodoWrite", extra: true }],
      display,
    }),
    { schemaVersion: 1, display },
  );
  assert.deepEqual(
    parseCompletedToolPartMetadata({ schemaVersion: 1, modelContent: 42, display }),
    { schemaVersion: 1, display },
  );
});
