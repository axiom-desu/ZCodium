import { describe, expect, it } from "vitest";

import {
  CONVERSATION_SHARE_CONTENT_VERSIONS,
  SHARE_CONTENT_LIMITS,
  conversationShareContentEnvelopeSchema,
  conversationShareContentBlockSchema,
  conversationShareContentBlocksSchema,
  conversationShareToolContentBlockSchema,
  conversationShareWorkflowContentBlockSchema,
  decodeConversationShareContentBlocks,
  supportsConversationShareContent,
} from "./conversation-share-content.js";
import { projectShareToolDisplay } from "./conversation-share-tool-presentation.js";
import { CONVERSATION_ARCHIVE_LIMITS } from "./conversation-archive.js";
import { CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES } from "./conversation-share-preview.js";
import {
  classifyConversationShareError,
  conversationSharePreviewDataSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  localizeConversationShareUrl,
  parseConversationSharePathname,
} from "./conversation-share.js";
import { conversationRowSchema, type ConversationRow } from "./zcode-protocol-v4/rows.js";

const SHA = "a".repeat(64);

function turnHeaderRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    ...overrides,
  };
}

function userInputRow(rowId = 2) {
  return {
    rowId,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: "hello",
    clientId: "client-1",
  };
}

function assistantRow(rowId = 3) {
  return {
    rowId,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "assistantText",
    state: "complete",
    text: "fallback",
  };
}

function workflowBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-content-1",
    type: "workflow",
    version: 2,
    product_turn_id: "share-product-turn-1",
    fallback_row_id: 1,
    captured_at: 1,
    resource_ids: [],
    payload: {
      name: "Weekly report",
      completion: true,
      artifacts: [],
    },
    ...overrides,
  };
}

function toolBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-content-1",
    type: "tool-presentation",
    version: 1,
    product_turn_id: "share-product-turn-1",
    fallback_row_id: 1,
    captured_at: 1,
    resource_ids: ["share-artifact-1"],
    payload: {
      images: [{ resource_id: "share-artifact-1", mime_type: "image/png" }],
    },
    ...overrides,
  };
}

function previewPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    share: {
      title: "Shared conversation",
      access_mode: "public_readonly",
      created_at: 1,
      expires_at: 2,
    },
    rows: [turnHeaderRow(), userInputRow(), assistantRow()],
    artifacts: [],
    integrity: {
      projection_sha256: SHA,
      artifact_set_sha256: SHA,
    },
    ...overrides,
  };
}

describe("conversation share content contract", () => {
  it("declares the current content versions and bounded limits", () => {
    expect(CONVERSATION_SHARE_CONTENT_VERSIONS).toEqual({ workflow: 2, "tool-presentation": 1 });
    expect(SHARE_CONTENT_LIMITS).toEqual({
      blocks: 200,
      artifacts: 32,
      items: 256,
      jsonDepth: 16,
      jsonBytes: 32768,
    });
  });

  it("bounds the anonymous preview body by the public projection contract", () => {
    // preview data 与归档 manifest 是同一份公开投影：上限不能被随手取得比受支持的
    // 公开载荷还小，否则合法分享会在读取端被误判为 limit_exceeded。
    expect(CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES).toBeGreaterThanOrEqual(
      CONVERSATION_ARCHIVE_LIMITS.manifestBytes,
    );
    expect(CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES).toBeLessThan(
      CONVERSATION_ARCHIVE_LIMITS.archiveBytes,
    );
  });

  it("accepts workflow v1 without text previews and rejects previews in v1", () => {
    const legacy = workflowBlock({
      version: 1,
      payload: {
        name: "Weekly report",
        completion: true,
        artifacts: [{ id: "a-1", kind: "file", title: "report.pdf", version: 1, bytes: 3 }],
      },
    });
    expect(conversationShareWorkflowContentBlockSchema.safeParse(legacy).success).toBe(true);

    const legacyWithPreview = workflowBlock({
      version: 1,
      payload: {
        name: "Weekly report",
        completion: true,
        artifacts: [
          {
            id: "a-1",
            kind: "markdown",
            title: "report.md",
            version: 1,
            preview_text: "body",
          },
        ],
      },
    });
    expect(conversationShareWorkflowContentBlockSchema.safeParse(legacyWithPreview).success).toBe(
      false,
    );

    const v2WithPreview = workflowBlock({
      version: 2,
      payload: {
        name: "Weekly report",
        completion: true,
        artifacts: [
          {
            id: "a-1",
            kind: "markdown",
            title: "report.md",
            version: 1,
            preview_text: "body",
          },
        ],
      },
    });
    expect(conversationShareWorkflowContentBlockSchema.safeParse(v2WithPreview).success).toBe(true);
  });

  it("declares unavailable results instead of emitting an empty deprecated payload", () => {
    const unavailable = workflowBlock({
      payload: {
        name: "Weekly report",
        completion: false,
        artifacts: [
          { id: "a-1", kind: "chart", title: "chart", version: 1, unavailable: "unsupported" },
        ],
        unavailable: "source_unavailable",
      },
    });
    const parsed = conversationShareWorkflowContentBlockSchema.safeParse(unavailable);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.payload.unavailable).toBe("source_unavailable");
    expect(parsed.data.payload.artifacts[0]?.unavailable).toBe("unsupported");
    // 未采集到运行态时只能用显式 unavailable 表达，不允许造一个没有来源的空 run。
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        workflowBlock({
          payload: {
            name: "Weekly report",
            completion: false,
            run: { status: "running" },
            artifacts: [],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires tool-presentation media references to match resource_ids", () => {
    expect(conversationShareToolContentBlockSchema.safeParse(toolBlock()).success).toBe(true);
    expect(
      conversationShareToolContentBlockSchema.safeParse(
        toolBlock({ resource_ids: ["share-artifact-2"] }),
      ).success,
    ).toBe(false);
    expect(
      conversationShareToolContentBlockSchema.safeParse(
        toolBlock({
          resource_ids: [],
          payload: { images: [{ resource_id: "share-artifact-1", mime_type: "image/png" }] },
        }),
      ).success,
    ).toBe(false);
    expect(
      conversationShareToolContentBlockSchema.safeParse(
        toolBlock({
          resource_ids: ["share-artifact-1", "share-artifact-2"],
          payload: { images: [{ resource_id: "share-artifact-1", mime_type: "image/png" }] },
        }),
      ).success,
    ).toBe(false);
  });

  it("bounds images to 32 and enforces image MIME types", () => {
    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      resource_id: `share-artifact-${index + 1}`,
      mime_type: "image/png",
    }));
    expect(
      conversationShareToolContentBlockSchema.safeParse(
        toolBlock({
          resource_ids: tooMany.map((image) => image.resource_id),
          payload: { images: tooMany },
        }),
      ).success,
    ).toBe(false);
    expect(
      conversationShareToolContentBlockSchema.safeParse(
        toolBlock({
          resource_ids: ["share-artifact-1"],
          payload: { images: [{ resource_id: "share-artifact-1", mime_type: "text/html" }] },
        }),
      ).success,
    ).toBe(false);
  });

  it("bounds blocks, artifacts, items, JSON bytes and JSON depth", () => {
    const tooManyBlocks = Array.from({ length: SHARE_CONTENT_LIMITS.blocks + 1 }, (_, index) =>
      workflowBlock({ id: `share-content-${index + 1}` }),
    );
    expect(decodeConversationShareContentBlocks(tooManyBlocks)).toHaveLength(
      SHARE_CONTENT_LIMITS.blocks + 1,
    );
    // 单块合法，但容器边界（存档/发布载荷）拒绝超限数量。
    expect(conversationShareContentBlocksSchema.safeParse(tooManyBlocks).success).toBe(false);
    expect(conversationShareContentBlocksSchema.safeParse(tooManyBlocks.slice(0, -1)).success).toBe(
      true,
    );

    const tooManyArtifacts = Array.from(
      { length: SHARE_CONTENT_LIMITS.artifacts + 1 },
      (_, index) => ({ id: `a-${index}`, kind: "file", title: `f-${index}`, version: 1 }),
    );
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        workflowBlock({ payload: { name: "n", completion: true, artifacts: tooManyArtifacts } }),
      ).success,
    ).toBe(false);

    const tooManyItems = Array.from({ length: SHARE_CONTENT_LIMITS.items + 1 }, (_, index) => ({
      sequence: index,
      siteId: "s1",
      ordinal: index,
      item: { value: index },
    }));
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        workflowBlock({
          payload: {
            name: "n",
            completion: true,
            artifacts: [
              {
                id: "a-1",
                kind: "table",
                title: "table",
                version: 1,
                items: tooManyItems,
              },
            ],
          },
        }),
      ).success,
    ).toBe(false);

    const oversizedJson = { rows: ["x".repeat(SHARE_CONTENT_LIMITS.jsonBytes)] };
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        workflowBlock({
          payload: {
            name: "n",
            completion: true,
            artifacts: [
              {
                id: "a-1",
                kind: "table",
                title: "table",
                version: 1,
                items: [{ sequence: 0, siteId: "s1", ordinal: 0, item: oversizedJson }],
              },
            ],
          },
        }),
      ).success,
    ).toBe(false);

    let deep: Record<string, unknown> = { value: 1 };
    for (let index = 0; index < SHARE_CONTENT_LIMITS.jsonDepth + 2; index += 1) {
      deep = { nested: deep };
    }
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        workflowBlock({
          payload: {
            name: "n",
            completion: true,
            artifacts: [
              {
                id: "a-1",
                kind: "table",
                title: "table",
                version: 1,
                items: [{ sequence: 0, siteId: "s1", ordinal: 0, item: deep }],
              },
            ],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects internal URIs, prototype keys and oversized strings in artifact JSON", () => {
    const buildWithItem = (item: unknown) =>
      workflowBlock({
        payload: {
          name: "n",
          completion: true,
          artifacts: [
            {
              id: "a-1",
              kind: "table",
              title: "table",
              version: 1,
              items: [{ sequence: 0, siteId: "s1", ordinal: 0, item }],
            },
          ],
        },
      });
    for (const value of [
      "file:///home/user/secret",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "zcode-artifact://share/abc",
    ]) {
      expect(
        conversationShareWorkflowContentBlockSchema.safeParse(buildWithItem({ value })).success,
      ).toBe(false);
    }
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(
        buildWithItem(JSON.parse('{"__proto__":{"polluted":true}}')),
      ).success,
    ).toBe(false);
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(buildWithItem({ constructor: "x" }))
        .success,
    ).toBe(false);
    expect(
      conversationShareWorkflowContentBlockSchema.safeParse(buildWithItem({ value: "plain" }))
        .success,
    ).toBe(true);
  });

  it("keeps unknown block types as envelopes without claiming their fallback row", () => {
    const envelope = conversationShareContentEnvelopeSchema.parse({
      ...workflowBlock({ type: "future-block", version: 3, payload: { anything: true } }),
    });
    expect(envelope.type).toBe("future-block");
    expect(envelope.version).toBe(3);

    expect(
      decodeConversationShareContentBlocks([
        workflowBlock({ id: "share-content-1" }),
        workflowBlock({ id: "share-content-2", type: "unknown", version: 9 }),
        { id: "bad" },
      ]),
    ).toHaveLength(1);
  });

  it("negotiates content support per capability version map", () => {
    expect(supportsConversationShareContent({ content_block_versions: { workflow: 2 } })).toBe(
      true,
    );
    expect(
      supportsConversationShareContent({ content_block_versions: { workflow: 1 } }, "workflow", 2),
    ).toBe(false);
    expect(supportsConversationShareContent({}, "tool-presentation")).toBe(false);
    expect(
      supportsConversationShareContent(
        { content_block_versions: { "tool-presentation": 1 } },
        "tool-presentation",
      ),
    ).toBe(true);
  });

  it("projects tool displays onto the public whitelist only", () => {
    const projected = projectShareToolDisplay({
      kind: "bash_output",
      output: "npm test",
      truncated: false,
      outputPath: "/home/user/private.log",
      input: { command: "npm test" },
    });
    expect(projected).toEqual({ kind: "bash_output", output: "npm test", truncated: false });

    expect(
      projectShareToolDisplay({
        kind: "cua",
        schemaVersion: 1,
        toolName: "desktop_click",
        status: "success",
        media: [{ mimeType: "image/png", data: "AAAA" }],
        targetApp: { schemaVersion: 1, displayName: "Notes" },
        permissionStatus: "granted",
      }),
    ).toEqual({ kind: "cua", schemaVersion: 1, toolName: "desktop_click", status: "success" });

    // 不在公开白名单的 display 类型（含插件 UI 元数据）不落 payload。
    expect(projectShareToolDisplay({ kind: "create_workflow", ok: true })).toBeUndefined();
    expect(projectShareToolDisplay("not-a-display")).toBeUndefined();
  });

  it("rejects malformed content blocks instead of silently degrading their shape", () => {
    expect(conversationShareContentBlockSchema.safeParse(workflowBlock()).success).toBe(true);
    expect(
      conversationShareContentBlockSchema.safeParse(workflowBlock({ id: "content-1" })).success,
    ).toBe(false);
    expect(
      conversationShareContentBlockSchema.safeParse(workflowBlock({ fallback_row_id: 0 })).success,
    ).toBe(false);
  });
});

describe("conversation share preview wire contract", () => {
  it("accepts unknown rows and only http(s) artifact downloads", () => {
    const artifact = {
      artifact_id: "share-artifact-1",
      logical_artifact_key: "k",
      producer_product_turn_id: "p",
      artifact_version: 1,
      state: "current",
      ref: "zcode-artifact://share/a1",
      artifact_type: "image",
      display_name: "shot.png",
      extension: "png",
      mime_type: "image/png",
      size_bytes: 3,
      sha256: SHA,
      url: "https://cdn.example.com/shot.png",
      url_expires_at: 1,
    };
    const payload = previewPayload({
      rows: [...previewPayload().rows, { kind: "futureRow", rowId: 99 }],
      artifacts: [artifact],
    });
    expect(conversationSharePreviewDataSchema.safeParse(payload).success).toBe(true);

    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AA"]) {
      expect(
        conversationSharePreviewDataSchema.safeParse({
          ...payload,
          artifacts: [{ ...artifact, url }],
        }).success,
      ).toBe(false);
    }
  });

  it("keeps schema negotiation explicit for newer payload versions", () => {
    expect(isConversationShareSchemaVersionSupported(1)).toBe(true);
    expect(isConversationShareSchemaVersionSupported(2)).toBe(false);
    expect(classifyConversationShareError(200, 3203)).toBe("unsupported_schema_version");
    expect(classifyConversationShareError(429)).toBe("rate_limited");
    expect(classifyConversationShareError(502)).toBe("service_unavailable");
    expect(classifyConversationShareError(200, 9999)).toBe("unknown");
  });

  it("decodes rows individually so one unknown kind cannot close the page", () => {
    const decoded = decodeConversationShareRows([
      turnHeaderRow(),
      userInputRow(),
      assistantRow(),
      { kind: "futureRow", rowId: 4 },
    ]);
    expect(decoded.rows).toHaveLength(3);
    expect(decoded.unsupportedCount).toBe(1);
    expect(decoded.unsupportedKinds).toEqual(["futureRow"]);
    // 已解码的行仍然是正式 row schema 的形状。
    expect(conversationRowSchema.safeParse(decoded.rows[0] as ConversationRow).success).toBe(true);
  });

  it("parses canonical share routes and localizes known links only", () => {
    expect(parseConversationSharePathname("/cn/share/abc")).toEqual({
      rawCode: "abc",
      locale: "zh-CN",
    });
    expect(parseConversationSharePathname("/share/abc/")).toEqual({
      rawCode: "abc",
      locale: "en-US",
    });
    expect(parseConversationSharePathname("/cn/other/abc")).toBeNull();
    expect(localizeConversationShareUrl("https://zcode.z.ai/share/a%2Fb", "zh-CN")).toBe(
      "https://zcode.z.ai/cn/share/a%2Fb",
    );
    expect(localizeConversationShareUrl("https://example.com/whatever/1", "zh-CN")).toBe(
      "https://example.com/whatever/1",
    );
  });
});
