import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  conversationShareContentBlockSchema,
  conversationShareContentBlocksSchema,
  type ConversationRow,
} from "@zcode/shared";
import { ZipFile } from "yazl";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "../src/conversation-share/conversationShareArtifactSource.js";
import { conversationArchiveCapabilities } from "../src/conversation-share/conversationArchiveCapabilities.js";
import {
  decodeConversationArchive,
  encodeConversationArchive,
  ConversationArchiveError,
} from "../src/conversation-share/conversationArchive.js";
import { materializeConversationShareInlineImages } from "../src/conversation-share/conversationShareInlineImages.js";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
} from "../src/conversation-share/conversationShareWorkflowSnapshot.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const base = { turnId: "turn-1", productTurnId: "product-turn-1", createdAt: 1 } as const;

function headerRow(rowId = 1): ConversationRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  } as ConversationRow;
}

function userRow(rowId = 2): ConversationRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: "summarize the report",
    clientId: "client-1",
  } as ConversationRow;
}

function assistantRow(rowId = 3): ConversationRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    state: "complete",
    text: "final answer",
  } as ConversationRow;
}

function imageToolRow(rowId = 4): ConversationRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
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
      display: {
        kind: "cua",
        schemaVersion: 1,
        toolName: "desktop_screenshot",
        status: "success",
        media: [{ mimeType: "image/png", data: PNG_BASE64 }],
        targetApp: { schemaVersion: 1, displayName: "Notes" },
      },
    },
  } as ConversationRow;
}

type WorkflowRow = ConversationRow & { entityId?: string };

function workflowHeaderRow(rowId = 5): WorkflowRow {
  return {
    ...base,
    rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "workflowLaunch",
    state: "completedSuccess",
    startedAt: 1,
    workflowLaunch: { runId: "run-1", name: "Weekly report" },
  } as WorkflowRow;
}

function workflowLaunchRow(): WorkflowRow {
  return {
    ...base,
    rowId: 6,
    createdAtSeq: 6,
    kind: "userInput",
    origin: "workflowLaunch",
    text: "workflow launched",
    workflowLaunch: { runId: "run-1", name: "Weekly report" },
  } as WorkflowRow;
}

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

function fakeWorkflowAgent(options: { fail?: boolean } = {}) {
  return {
    conversationWorkflowRunsV4: async () => ({
      runs: [{ runId: "run-1", label: "Weekly report", status: "completed" }],
    }),
    conversationWorkflowRunEventsV4: async () => {
      if (options.fail) throw new Error("journal unavailable");
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

test("inline images become public artifacts and never leak base64 into rows", () => {
  const capabilities = conversationArchiveCapabilities();
  const source = [headerRow(), userRow(), assistantRow(), imageToolRow()];
  const result = materializeConversationShareInlineImages(
    source,
    capabilities,
    new Map([["product-turn-1", 1]]),
  );
  assert.equal(result.warnings.length, 0);
  const toolRow = result.rows.find((row) => row.kind === "toolCall");
  assert.ok(toolRow && toolRow.kind === "toolCall");
  assert.equal(toolRow.display, undefined);
  const artifactRows = result.rows.filter((row) => row.kind === "artifact");
  assert.equal(artifactRows.length, 2);
  for (const row of artifactRows) {
    assert.equal(row.artifactType, "image");
    assert.ok(!("display" in row));
    assert.match(row.sha256, /^[0-9a-f]{64}$/u);
  }
  const expected = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
  assert.equal(artifactRows[0]?.sha256, expected);
  assert.deepEqual(
    [...result.toolImages.get(imageToolRow().rowId ?? 4)!].map((image) => image.mimeType),
    ["image/png", "image/png"],
  );
  // 顶层 node_repl_images 通道已删除；cua media 的原始字节仍留在 output 上，
  // 由公开投影（只保留 output.text）负责剪掉，见下方 projection 测试。
  assert.equal(result.rows.filter((row) => row.kind === "toolCall")[0]?.kind, "toolCall");
});

test("unsupported inline image MIME and corrupt base64 degrade to explicit warnings", () => {
  const capabilities = conversationArchiveCapabilities();
  const corrupt: ConversationRow = {
    ...imageToolRow(4),
    display: { kind: "node_repl_images", images: [{ base64: "!!!", mimeType: "image/png" }] },
    output: undefined,
  } as ConversationRow;
  const unsupported: ConversationRow = {
    ...imageToolRow(6),
    display: { kind: "node_repl_images", images: [{ base64: PNG_BASE64, mimeType: "image/bmp" }] },
    output: undefined,
  } as ConversationRow;
  const result = materializeConversationShareInlineImages(
    [headerRow(), userRow(), corrupt, unsupported],
    capabilities,
    new Map([["product-turn-1", 1]]),
  );
  assert.equal(result.rows.filter((row) => row.kind === "artifact").length, 0);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["artifact_read_failed", "artifact_type_not_allowed"],
  );
});

test("workflow snapshot emits a v2 draft with bounded public artifacts", async () => {
  const capabilities = conversationArchiveCapabilities();
  const rows = [workflowHeaderRow(), userRow(), workflowLaunchRow(), assistantRow(7)];
  const snapshot = await collectConversationShareWorkflowSnapshot({
    agent: fakeWorkflowAgent() as never,
    input: { workspacePath: "/workspace", sessionId: "session-1" } as never,
    rows,
    allRows: rows,
    capabilities,
    capturedAt: 1_000,
  });
  assert.equal(snapshot.drafts.length, 1);
  const draft = snapshot.drafts[0]!;
  assert.equal(draft.version, 2);
  assert.equal(draft.productTurnId, "product-turn-1");
  const artifact = draft.payload.artifacts[0];
  assert.ok(artifact && (artifact.kind === "file" || artifact.kind === "markdown"));
  assert.equal(artifact.bytes, 21);
  assert.equal(artifact.preview_text, "# Report\nshared body\n");
  assert.ok(!JSON.stringify(draft).includes("/home/user/project/report.md"));
  // fallback 行说明卡片不可读时的原位摘要，且不会被当成文件引用来源。
  const fallback = snapshot.rows.find(
    (row) => row.kind === "assistantText" && row.entityId?.startsWith("workflow-share-fallback-"),
  );
  assert.ok(fallback && isWorkflowShareFallbackRow(fallback));
  assert.deepEqual([...snapshot.bytes.keys()], ["workflow-resource-1"]);
});

test("workflow snapshot degrades to an explicit unavailable fallback instead of a fake run", async () => {
  const capabilities = conversationArchiveCapabilities();
  const rows = [workflowHeaderRow(), userRow(), workflowLaunchRow()];
  const snapshot = await collectConversationShareWorkflowSnapshot({
    agent: fakeWorkflowAgent({ fail: true }) as never,
    input: { workspacePath: "/workspace", sessionId: "session-1" } as never,
    rows,
    allRows: rows,
    capabilities,
    capturedAt: 1_000,
  });
  const draft = snapshot.drafts[0]!;
  assert.equal(draft.payload.unavailable, "source_unavailable");
  assert.equal(draft.payload.run, undefined);
  assert.deepEqual(draft.payload.artifacts, []);
  const fallback = snapshot.rows.find(
    (row) => row.kind === "assistantText" && row.entityId?.startsWith("workflow-share-fallback-"),
  );
  assert.ok(fallback && fallback.kind === "assistantText");
  assert.match(fallback.text, /snapshot unavailable/iu);
  // 公开投影后必须仍是「一块 + 一条可读摘要」：块没有 run/artifacts，摘要挂在块引用的
  // fallback row 上。浏览器用例（conversation-share-web-smoke.mjs）直接吃这份形状。
  const projection = buildConversationSharePublicProjection({
    rows: snapshot.rows,
    selectedProductTurnIds: ["product-turn-1"],
    contentDrafts: snapshot.drafts,
  });
  const block = projection.contentBlocks?.[0];
  assert.ok(block && block.type === "workflow");
  assert.equal(block.payload.unavailable, "source_unavailable");
  assert.equal(block.payload.run, undefined);
  assert.deepEqual(block.payload.artifacts, []);
  const projectedFallback = projection.rows.find((row) => row.rowId === block.fallback_row_id);
  assert.ok(projectedFallback && projectedFallback.kind === "assistantText");
  assert.match(projectedFallback.text, /snapshot unavailable/iu);
});

test("workflow v1 capabilities omit text previews and keep version 1", async () => {
  const capabilities = {
    ...conversationArchiveCapabilities(),
    content_block_versions: { workflow: 1 },
  };
  const rows = [workflowHeaderRow(), userRow(), workflowLaunchRow()];
  const snapshot = await collectConversationShareWorkflowSnapshot({
    agent: fakeWorkflowAgent() as never,
    input: { workspacePath: "/workspace", sessionId: "session-1" } as never,
    rows,
    allRows: rows,
    capabilities,
    capturedAt: 1_000,
  });
  const draft = snapshot.drafts[0]!;
  assert.equal(draft.version, 1);
  const artifact = draft.payload.artifacts[0];
  assert.ok(artifact);
  assert.equal("preview_text" in artifact, false);
  assert.equal("bytes" in artifact ? artifact.bytes : undefined, 21);
});

test("public projection maps ids and emits workflow plus tool-presentation blocks", async () => {
  const capabilities = conversationArchiveCapabilities();
  const allRows = [
    workflowHeaderRow(),
    userRow(),
    assistantRow(),
    imageToolRow(4),
    workflowLaunchRow(),
  ];
  const inline = materializeConversationShareInlineImages(
    allRows,
    capabilities,
    new Map([["product-turn-1", 1]]),
  );
  const snapshot = await collectConversationShareWorkflowSnapshot({
    agent: fakeWorkflowAgent() as never,
    input: { workspacePath: "/workspace", sessionId: "session-1" } as never,
    rows: inline.rows,
    allRows,
    capabilities,
    capturedAt: 1_000,
  });
  const projection = buildConversationSharePublicProjection({
    rows: snapshot.rows,
    selectedProductTurnIds: ["product-turn-1"],
    toolPresentation: true,
    toolImages: inline.toolImages,
    sourceRows: allRows,
    contentDrafts: snapshot.drafts,
  });
  const blocks = projection.contentBlocks ?? [];
  assert.equal(blocks.length, 2);
  const workflow = blocks.find((block) => block.type === "workflow");
  const tool = blocks.find((block) => block.type === "tool-presentation");
  assert.ok(workflow && workflow.type === "workflow");
  assert.ok(tool && tool.type === "tool-presentation");
  assert.equal(workflow.version, 2);
  assert.match(workflow.product_turn_id, /^share-product-turn-\d+$/u);
  assert.match(workflow.id, /^share-content-\d+$/u);
  // 所有资源 id 都是公开闭集里的 id，且与块内引用一致。
  const artifactIds = new Set(
    projection.artifacts.map((artifact) => artifact.descriptor.artifact_id),
  );
  for (const resourceId of workflow.resource_ids) assert.ok(artifactIds.has(resourceId));
  for (const image of tool.payload.images ?? []) {
    assert.ok(artifactIds.has(image.resource_id));
    assert.equal(image.mime_type, "image/png");
  }
  assert.equal(tool.payload.app_name, "Notes");
  assert.equal(tool.payload.display?.kind, "cua");
  // 公开载荷里不能出现本地路径或内嵌图片字节。
  const serialized = JSON.stringify(projection);
  assert.ok(!serialized.includes("/home/user/project/report.md"));
  assert.ok(!serialized.includes(PNG_BASE64));
});

test("archive v2 round-trips content blocks and enforces block references", async () => {
  const capabilities = conversationArchiveCapabilities();
  const allRows = [headerRow(), userRow(), assistantRow(), imageToolRow(4)];
  const inline = materializeConversationShareInlineImages(
    allRows,
    capabilities,
    new Map([["product-turn-1", 1]]),
  );
  const projection = buildConversationSharePublicProjection({
    rows: inline.rows,
    selectedProductTurnIds: ["product-turn-1"],
    toolPresentation: true,
    toolImages: inline.toolImages,
    sourceRows: allRows,
  });
  const blocks = conversationShareContentBlocksSchema.parse(projection.contentBlocks);
  const artifacts = projection.artifacts.map((artifact) => {
    const bytes = inline.bytesBySourceRef.get(artifact.sourceRef);
    assert.ok(bytes);
    return { descriptor: artifact.descriptor, bytes };
  });
  const encoded = await encodeConversationArchive({
    title: "shared",
    selectedProductTurnIds: projection.selectedProductTurnIds,
    rows: projection.rows,
    contentBlocks: blocks,
    artifacts,
  });
  const decoded = await decodeConversationArchive(encoded);
  assert.equal(decoded.content.version, 2);
  if (decoded.content.version !== 2) return;
  assert.equal(decoded.content.content_blocks.length, blocks.length);
  assert.equal(decoded.content.content_blocks[0]?.type, "tool-presentation");

  // 旧版 v1 归档（无内容块）仍可读取。
  const legacy = await encodeConversationArchive({
    title: "legacy",
    selectedProductTurnIds: projection.selectedProductTurnIds,
    rows: projection.rows,
    artifacts,
  });
  const legacyDecoded = await decodeConversationArchive(legacy);
  assert.equal(legacyDecoded.content.version, 1);

  // 块引用不存在的资源 → invalid_archive，而不是把悬空卡片交给渲染端。
  const dangling = conversationShareContentBlockSchema.parse({
    ...blocks[0]!,
    resource_ids: ["share-artifact-999"],
    payload: {
      ...blocks[0]!.payload,
      images: [{ resource_id: "share-artifact-999", mime_type: "image/png" }],
    },
  });
  await assert.rejects(
    encodeConversationArchive({
      title: "dangling",
      selectedProductTurnIds: projection.selectedProductTurnIds,
      rows: projection.rows,
      contentBlocks: [dangling],
      artifacts,
    }),
    (error: unknown) => error instanceof ConversationArchiveError,
  );
});

test("unknown archive versions are rejected as unsupported, not as corrupt", async () => {
  const capabilities = conversationArchiveCapabilities();
  const allRows = [headerRow(), userRow(), assistantRow()];
  const projection = buildConversationSharePublicProjection({
    rows: allRows,
    selectedProductTurnIds: ["product-turn-1"],
  });
  const encoded = await encodeConversationArchive({
    title: "legacy",
    selectedProductTurnIds: projection.selectedProductTurnIds,
    rows: projection.rows,
    artifacts: [],
  });
  assert.ok(encoded.length > 0);
  // 用一个未来版本的 manifest 造归档：读取端必须区分「请升级」与「文件损坏」。
  const content = {
    format: "zcodium-conversation",
    version: 9,
    title: "future",
    selectedProductTurnIds: ["share-product-turn-1"],
    rows: projection.rows,
    artifacts: [],
  };
  const manifest = {
    content,
    sha256: createHash("sha256")
      .update(
        JSON.stringify({
          format: content.format,
          version: content.version,
          title: content.title,
          selectedProductTurnIds: content.selectedProductTurnIds,
          rows: content.rows,
          artifacts: content.artifacts,
        }),
      )
      .digest("hex"),
  };
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest), "utf8"), "manifest.json");
  zip.end();
  await new Promise<void>((resolve) => zip.outputStream.on("end", () => resolve()));
  await assert.rejects(
    decodeConversationArchive(Buffer.concat(chunks)),
    (error: unknown) =>
      error instanceof ConversationArchiveError && error.code === "unsupported_version",
  );
  assert.ok(capabilities.content_block_versions);
});

test("service publish writes archive v2 blocks from the same preflight pipeline", async () => {
  const rows = [workflowHeaderRow(1), userRow(), assistantRow(), imageToolRow(4)];
  const agent = {
    conversationRowsRangeV4: async () => ({
      rows,
      hasMore: false,
      atLogEpoch: "epoch-1",
      atRevision: 3,
    }),
    ...fakeWorkflowAgent(),
  };
  const service = new ConversationShareService({
    zcodeAgentService: agent as never,
    artifactSource: createLocalConversationShareArtifactSource(),
  });
  const input = {
    workspacePath: "/tmp/s11b-workspace",
    sessionId: "session-1",
    title: "Quarterly review",
    selection: { kind: "productTurns" as const, productTurnIds: ["product-turn-1"] },
    clientRequestId: "request-1",
  };
  const preflight = await service.preflight(input);
  assert.deepEqual(preflight.blockingIssues, []);
  assert.equal(preflight.turnResults.length, 1);
  assert.equal(
    preflight.turnResults[0]?.rowBudget?.limit,
    conversationArchiveCapabilities().max_rows,
  );
  assert.ok((preflight.turnResults[0]?.rowBudget?.count ?? 0) > 0);
  // 工具展示与内嵌图片进入公开载荷，因此不产生「内容不可用」提示。
  assert.equal(
    preflight.skippableWarnings.some((warning) => warning.code === "content_unavailable"),
    false,
  );

  const exported = await service.publish(input, "operation-1");
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < exported.byteLength) {
    const chunk = Buffer.from(await service.readExportChunk(exported.archiveId, offset), "base64");
    assert.ok(chunk.length > 0);
    chunks.push(chunk);
    offset += chunk.length;
  }
  await service.releaseExport(exported.archiveId);
  const decoded = await decodeConversationArchive(Buffer.concat(chunks));
  assert.equal(decoded.content.version, 2);
  if (decoded.content.version !== 2) return;
  assert.deepEqual(decoded.content.content_blocks.map((block) => block.type).sort(), [
    "tool-presentation",
    "workflow",
  ]);
  const workflow = decoded.content.content_blocks.find((block) => block.type === "workflow");
  assert.ok(workflow && workflow.type === "workflow");
  assert.equal(workflow.version, 2);
  assert.equal(workflow.payload.artifacts[0]?.kind, "markdown");
  assert.match(String(workflow.payload.artifacts[0]?.preview_text), /shared body/u);
  const tool = decoded.content.content_blocks.find((block) => block.type === "tool-presentation");
  assert.ok(tool && tool.type === "tool-presentation");
  assert.equal(tool.payload.images?.length, 2);
  // 图片字节真的进了归档，而不是只留了一个悬空 descriptor。
  for (const image of tool.payload.images ?? []) {
    assert.ok(decoded.artifacts.has(image.resource_id));
  }
  const serialized = JSON.stringify(decoded.content);
  assert.ok(!serialized.includes("/home/user/project/report.md"));
  assert.ok(!serialized.includes(PNG_BASE64));
});
