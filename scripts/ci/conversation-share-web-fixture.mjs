import assert from "node:assert/strict";

/**
 * 公开分享页 E2E 的预览载荷：由 packages/services 的真实分享流水线生成。
 *
 * 不是手写的“相似案例”：内嵌图片 → workflow 快照 → 公开投影走的都是生产 service 的同一份实现，
 * 因此用例覆盖的就是线上服务会发出的形状（含 run 读不到时合成的 assistantText 摘要 +
 * `unavailable` workflow 块）。
 */

const SHA = "a".repeat(64);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const UNAVAILABLE_SUMMARY = "Workflow snapshot unavailable / 工作流快照不可用";
const UNKNOWN_BLOCK_SUMMARY = "Unknown block fallback text";

// 直接把服务端 TS 源码加载进这个 Node 进程：用例形状与生产 service 保持同一份实现。
const { register } = await import("tsx/esm/api");
register();
const { conversationArchiveCapabilities } =
  await import("../../packages/services/src/conversation-share/conversationArchiveCapabilities.ts");
const { materializeConversationShareInlineImages } =
  await import("../../packages/services/src/conversation-share/conversationShareInlineImages.ts");
const { collectConversationShareWorkflowSnapshot } =
  await import("../../packages/services/src/conversation-share/conversationShareWorkflowSnapshot.ts");
const { buildConversationSharePublicProjection } =
  await import("../../packages/services/src/conversation-share/conversationSharePublicProjection.ts");
const { CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES } =
  await import("../../packages/shared/src/conversation-share-artifact.ts");

// 故意比共享 artifact 预算大 2 MiB，且不声明 Content-Length：验证生产渲染器在分块流上主动取消。
const LARGE_ARTIFACT_ID = "share-artifact-3";
const LARGE_ARTIFACT_BYTES = CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES + 2 * 1024 * 1024;

function workflowRunEvents() {
  return [
    { sequence: 1, type: "run-started", payload: {} },
    {
      sequence: 2,
      type: "artifact-published",
      payload: { artifact: { id: "artifact-md", kind: "markdown", version: 1 } },
    },
    { sequence: 3, type: "run-settled", payload: { status: "completed" } },
  ];
}

/** 与 services 测试同一形状的 workflow reader：一个正常 run，一个 journal 读不到。 */
function fakeWorkflowAgent() {
  return {
    conversationWorkflowRunsV4: async () => ({
      runs: [{ runId: "run-normal", label: "Weekly report" }],
    }),
    conversationWorkflowRunEventsV4: async ({ runId }) => {
      if (runId === "run-unavailable") throw new Error("journal unavailable");
      return { events: workflowRunEvents(), hasMore: false };
    },
    conversationWorkflowRunArtifactsV4: async () => ({
      artifacts: [
        {
          id: "artifact-md",
          kind: "markdown",
          title: "report.md",
          version: 1,
          versions: [
            {
              version: 1,
              title: "report.md",
              contentType: "text/markdown",
              sourcePath: "/home/user/project/report.md",
              bytes: 21,
            },
          ],
        },
      ],
    }),
    conversationWorkflowRunArtifactDataV4: async () => ({ items: [], hasMore: false }),
    conversationWorkflowRunArtifactReadV4: async () => {
      const bytes = Buffer.from("# Report\nshared body\n", "utf8");
      return {
        dataBase64: bytes.toString("base64"),
        mediaType: "text/markdown",
        totalBytes: bytes.length,
        nextOffset: null,
      };
    },
  };
}

/** 三轮：正常完成的 workflow、读不到 run 的 workflow、带内嵌图片的工具轮。 */
function conversationRows(artifactBase) {
  const loopbackPort = new URL(artifactBase).port;
  const rows = [];
  const push = (row) => {
    const rowId = rows.length + 1;
    rows.push({ ...row, rowId, createdAtSeq: rowId });
  };
  const common = (turnId, productTurnId) => ({ turnId, productTurnId, createdAt: 1 });
  push({
    ...common("turn-1", "product-turn-1"),
    kind: "turnHeader",
    origin: "workflowLaunch",
    state: "completedSuccess",
    startedAt: 1,
    workflowLaunch: { runId: "run-normal", name: "Weekly report" },
    originMeta: {
      workflowNotification: {
        kind: "terminal",
        status: "completed",
        summary: "Weekly report completed",
      },
    },
  });
  push({
    ...common("turn-1", "product-turn-1"),
    kind: "userInput",
    origin: "workflowLaunch",
    text: "workflow launched",
    workflowLaunch: { runId: "run-normal", name: "Weekly report" },
  });
  // 不可信正文单独一轮并放在轮尾：只读时间线只把每轮最后一段正文当正文显示。
  push({
    ...common("turn-4", "product-turn-4"),
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  });
  push({
    ...common("turn-4", "product-turn-4"),
    kind: "userInput",
    origin: "realUser",
    text: "open the links",
    clientId: "client-2",
  });
  push({
    ...common("turn-4", "product-turn-4"),
    kind: "assistantText",
    state: "complete",
    text: [
      '<img src=x onerror="window.__sharePwned=1"><script>window.__sharePwned=2</script>',
      "[unsafe](javascript:window.__sharePwned=3) and ![local](file:///etc/passwd) plus **safe markdown**",
      // 十进制/十六进制/百分号编码的 loopback：URL 解析后会归一化成 127.0.0.1，仍必须被拦。
      `[decimal](http://2130706433:${loopbackPort}/private-decimal) [hex](http://0x7f000001:${loopbackPort}/private-hex) [enc](http://%31%32%37.0.0.1:${loopbackPort}/private-enc)`,
      "[public](https://example.com/shared)",
    ].join("\n\n"),
  });
  push({
    ...common("turn-2", "product-turn-2"),
    kind: "turnHeader",
    origin: "workflowLaunch",
    state: "completedSuccess",
    startedAt: 1,
    workflowLaunch: { runId: "run-unavailable", name: "Weekly report workflow" },
  });
  push({
    ...common("turn-2", "product-turn-2"),
    kind: "userInput",
    origin: "workflowLaunch",
    text: "workflow launched",
    workflowLaunch: { runId: "run-unavailable", name: "Weekly report workflow" },
  });
  push({
    ...common("turn-3", "product-turn-3"),
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  });
  push({
    ...common("turn-3", "product-turn-3"),
    kind: "userInput",
    origin: "realUser",
    text: "capture the screen",
    clientId: "client-1",
  });
  push({
    ...common("turn-3", "product-turn-3"),
    kind: "toolCall",
    toolCallId: "tool-1",
    toolName: "node_repl",
    status: "success",
    inputText: "screenshot()",
    display: {
      kind: "node_repl_images",
      images: [{ base64: PNG_BASE64, mimeType: "image/png" }],
      app: { displayName: "Notes" },
    },
    output: {
      text: "captured",
      display: { kind: "bash_output", output: "$ npm test\nall green", truncated: false },
    },
  });
  return rows;
}

/**
 * 走真实 service 流水线生成预览载荷。
 *
 * 返回的 payload 与 `ConversationShareService.publish` 的公开投影同源；`files` 是
 * artifact 公网 id → 字节，供 loopback 下载端点使用。
 */
async function buildServicePreview(artifactBase) {
  const capabilities = conversationArchiveCapabilities();
  const sourceRows = conversationRows(artifactBase);
  const turnOrdinals = new Map([
    ["product-turn-1", 1],
    ["product-turn-2", 2],
    ["product-turn-3", 3],
    ["product-turn-4", 4],
  ]);
  const inline = materializeConversationShareInlineImages(sourceRows, capabilities, turnOrdinals);
  const snapshot = await collectConversationShareWorkflowSnapshot({
    agent: fakeWorkflowAgent(),
    input: { workspacePath: "/workspace", sessionId: "session-1" },
    rows: inline.rows,
    allRows: sourceRows,
    capabilities,
    capturedAt: 1_000,
  });
  const projection = buildConversationSharePublicProjection({
    rows: snapshot.rows,
    selectedProductTurnIds: [
      "product-turn-1",
      "product-turn-2",
      "product-turn-3",
      "product-turn-4",
    ],
    toolPresentation: true,
    toolImages: inline.toolImages,
    sourceRows,
    contentDrafts: snapshot.drafts,
  });
  const bytesBySourceRef = new Map([
    ...inline.bytesBySourceRef.entries(),
    ...snapshot.bytes.entries(),
  ]);
  const files = new Map();
  const artifacts = projection.artifacts.map(({ sourceRef, descriptor }) => {
    const bytes = bytesBySourceRef.get(sourceRef);
    assert.ok(bytes, `artifact bytes are missing for ${sourceRef}`);
    files.set(descriptor.artifact_id, { bytes, mimeType: descriptor.mime_type });
    return {
      ...descriptor,
      url: `${artifactBase}/files/${descriptor.artifact_id}`,
      url_expires_at: Date.now() + 86_400_000,
    };
  });
  // 额外一件超过共享预算的 artifact：真实渲染器必须主动取消分块流并只让这张卡报错。
  artifacts.push({
    artifact_id: LARGE_ARTIFACT_ID,
    logical_artifact_key: "share-artifact-key-3",
    producer_product_turn_id: "share-product-turn-1",
    artifact_version: 1,
    state: "current",
    ref: "zcode-artifact://share/share-artifact-3",
    artifact_type: "md",
    display_name: "oversized.md",
    extension: "md",
    mime_type: "text/markdown",
    size_bytes: LARGE_ARTIFACT_BYTES,
    sha256: SHA,
    url: `${artifactBase}/files/${LARGE_ARTIFACT_ID}`,
    url_expires_at: Date.now() + 86_400_000,
  });
  const rows = projection.rows;
  const contentBlocks = [...(projection.contentBlocks ?? [])];
  const primaryWorkflowBlock = contentBlocks.find(
    (block) => block.type === "workflow" && block.payload.completion,
  );
  assert.ok(primaryWorkflowBlock, "the fixture must contain a completed workflow block");
  primaryWorkflowBlock.resource_ids.push(LARGE_ARTIFACT_ID);
  primaryWorkflowBlock.payload.artifacts.push({
    id: "artifact-large",
    title: "oversized.md",
    version: 1,
    primary: true,
    kind: "markdown",
    resource_id: LARGE_ARTIFACT_ID,
    content_type: "text/markdown",
    bytes: LARGE_ARTIFACT_BYTES,
  });
  // 老落地页遇到新块类型：块本身不认识，但服务端同时发来的 row 必须照常显示一次。
  const unknownRowId = Math.max(...rows.map((row) => row.rowId)) + 1;
  const unknownProductTurnId = projection.selectedProductTurnIds[0];
  rows.push({
    rowId: unknownRowId,
    turnId: rows[0].turnId,
    productTurnId: unknownProductTurnId,
    createdAt: 1,
    createdAtSeq: unknownRowId,
    kind: "assistantText",
    state: "complete",
    text: UNKNOWN_BLOCK_SUMMARY,
  });
  contentBlocks.push({
    id: "share-content-99",
    type: "future-content-block",
    version: 9,
    product_turn_id: unknownProductTurnId,
    fallback_row_id: unknownRowId,
    captured_at: 1,
    resource_ids: [],
    payload: {},
  });
  // 本 build 不认识的 row kind：客户端逐行降级并给软提示。
  rows.push({ kind: "futureRow", rowId: unknownRowId + 1 });
  return {
    payload: {
      schema_version: 1,
      share: {
        title: "Quarterly review",
        access_mode: "public_readonly",
        created_at: 1,
        expires_at: Date.now() + 86_400_000,
      },
      rows,
      content_blocks: contentBlocks,
      artifacts,
      integrity: { projection_sha256: SHA, artifact_set_sha256: SHA },
    },
    unavailableBlockId: contentBlocks.find(
      (block) => block.type === "workflow" && block.payload.unavailable,
    )?.id,
    largeArtifactId: LARGE_ARTIFACT_ID,
    largeArtifactBytes: LARGE_ARTIFACT_BYTES,
    files,
  };
}

export {
  buildServicePreview,
  LARGE_ARTIFACT_BYTES,
  LARGE_ARTIFACT_ID,
  UNAVAILABLE_SUMMARY,
  UNKNOWN_BLOCK_SUMMARY,
};
