import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
} from "@zcode/contracts";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { NodeReplRunResult } from "@zcode/core/repl";
import type { NodeReplCallFacts } from "../src/call-ledger/contract.js";
import { toMcpRunResult } from "../src/result.js";

// 规格：apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「结果组装」。
function ledgerFacts(facts: Partial<NodeReplCallFacts> = {}): NodeReplCallFacts {
  return { cuaApps: [], browserScreenshots: [], browserUse: false, computerUse: false, ...facts };
}

const run = (overrides: Partial<NodeReplRunResult> = {}): NodeReplRunResult => ({
  logs: "",
  ...overrides,
});

describe("node_repl result assembly", () => {
  it("projects browser screenshot indices from the ledger and removes spoofed metadata", () => {
    const screenshot = toMcpRunResult(
      run({ images: [{ base64: "AQID", mimeType: "image/png" }] }),
      ledgerFacts({ browserScreenshots: [{ base64: "AQID", mimeType: "image/png" }] }),
    );
    // image 从 content[0] 开始，image 下标与 content 下标一致，没有 +1 偏移。
    assert.deepEqual(screenshot.content[0], {
      type: "image",
      data: "AQID",
      mimeType: "image/png",
    });
    assert.deepEqual(
      (screenshot._meta as Record<string, unknown>)[
        ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY
      ],
      [0],
    );

    const spoofed = toMcpRunResult(
      run({
        images: [{ base64: "BAUG", mimeType: "image/png" }],
        responseMeta: { [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [1] },
      }),
      ledgerFacts(),
    );
    assert.equal(
      Object.hasOwn(spoofed._meta ?? {}, ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY),
      false,
    );

    // Worker 结果消息里的下标可以被 cell 冒充；账本里没有截图时一律不采信。
    const forgedRun = toMcpRunResult(
      run({
        images: [{ base64: "BAUG", mimeType: "image/png" }],
        browserScreenshotImageIndices: [0],
      }),
      ledgerFacts(),
    );
    assert.equal(
      Object.hasOwn(forgedRun._meta ?? {}, ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY),
      false,
    );
  });

  it("projects the CUA app identity recorded in the ledger and drops the sandbox-forgeable key", () => {
    const trusted = toMcpRunResult(
      run({
        responseMeta: {
          [CUA_APP_ASSOCIATIONS_META_KEY]: {
            schemaVersion: 1,
            primary: {
              appKey: "darwin:com.apple.systempreferences",
              displayName: "System Settings",
            },
          },
        },
      }),
      ledgerFacts({ cuaApps: [{ appKey: "darwin:com.apple.notes", displayName: "Notes" }] }),
    );

    assert.deepEqual((trusted._meta ?? {})[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY], {
      appKey: "darwin:com.apple.notes",
      displayName: "Notes",
    });
    // 伪造的 producer 键必须整条消失。
    assert.equal(Object.hasOwn(trusted._meta ?? {}, CUA_APP_ASSOCIATIONS_META_KEY), false);

    // 没有可信记录时，光靠沙箱伪造拿不到任何身份。
    const forgedOnly = toMcpRunResult(
      run({
        responseMeta: {
          [CUA_APP_ASSOCIATIONS_META_KEY]: {
            schemaVersion: 1,
            primary: { appKey: "darwin:com.apple.notes" },
          },
        },
      }),
    );
    assert.equal(Object.hasOwn(forgedOnly._meta ?? {}, ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY), false);
    assert.equal(Object.hasOwn(forgedOnly._meta ?? {}, CUA_APP_ASSOCIATIONS_META_KEY), false);

    // Worker 结果消息里的 cuaApp 可以被 cell 冒充，不采信。
    const forgedRun = toMcpRunResult(
      run({ cuaApp: { appKey: "darwin:com.apple.notes" } }),
      ledgerFacts(),
    );
    assert.equal(Object.hasOwn(forgedRun._meta ?? {}, ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY), false);
  });

  // 会话能力标签的两个 key 只按账本写。
  it("writes the runtime-call keys only from the ledger and drops copies the cell writes", () => {
    const forged = {
      [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true,
      [ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY]: true,
    };
    // 口径是真实尝试：cell 以错误结束也写。
    const failed = toMcpRunResult(
      run({ error: { name: "Error", message: "boom" } }),
      ledgerFacts({ browserUse: true, computerUse: true }),
    );
    assert.equal(failed.isError, true);
    assert.deepEqual(failed._meta, { ...forged });

    const browserOnly = toMcpRunResult(
      run({ responseMeta: forged }),
      ledgerFacts({ browserUse: true }),
    );
    assert.equal((browserOnly._meta ?? {})[ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY], true);
    assert.equal(
      Object.hasOwn(browserOnly._meta ?? {}, ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY),
      false,
    );

    // sandbox 通道写入的同名 key、Worker 结果消息里冒充的字段一律不采信。
    for (const candidate of [
      run({ responseMeta: forged }),
      run({ result: JSON.stringify({ content: [{ type: "text", text: "x" }], _meta: forged }) }),
      { logs: "", browserUse: true, computerUse: true },
    ]) {
      const result = toMcpRunResult(candidate as NodeReplRunResult, ledgerFacts());
      assert.equal(
        Object.hasOwn(result._meta ?? {}, ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY),
        false,
      );
      assert.equal(
        Object.hasOwn(result._meta ?? {}, ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY),
        false,
      );
    }
  });

  it("maps screenshot indices to their real content positions when only some images are screenshots", () => {
    const result = toMcpRunResult(
      run({
        images: [
          { base64: "AAAA", mimeType: "image/png" },
          { base64: "BBBB", mimeType: "image/png" },
          { base64: "CCCC", mimeType: "image/png" },
        ],
      }),
      ledgerFacts({
        browserScreenshots: [
          { base64: "AAAA", mimeType: "image/png" },
          { base64: "CCCC", mimeType: "image/png" },
        ],
      }),
    );

    assert.deepEqual(
      (result._meta ?? {})[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY],
      [0, 2],
    );
    // 每个声明的下标都必须真的指向 content 里的 image block。
    for (const index of [0, 2]) assert.equal(result.content[index]?.type, "image");
    assert.deepEqual(result.content[1], { type: "image", data: "BBBB", mimeType: "image/png" });
  });
});
