import assert from "node:assert/strict";
import { it } from "node:test";
import type { FilePart, TurnAttachment } from "@zcode/contracts";

import { filePartToContentBlock } from "../src/agent/file-part-hydration.js";
import { resolvedPathReferenceAttachment } from "../src/runtime/helpers/attachment-path-reference.js";

/**
 * 路径引用附件冷恢复：首发说明文本必须逐字节复用，不能重造也不回退 preview。
 * 旧行（无 pathReferenceText）保持原占位行为，不回溯重算。
 */

const source = {
  type: "file" as const,
  path: "/workspace/reports/binary.bin",
  text: { value: "@reports/binary.bin", start: 0, end: 19 },
};

function storedPart(metadata: FilePart["metadata"], overrides: Partial<FilePart> = {}): FilePart {
  return {
    id: "part-1",
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "file",
    mime: "application/octet-stream",
    filename: "binary.bin",
    url: "/workspace/reports/binary.bin",
    source,
    metadata,
    ...overrides,
  } as FilePart;
}

it("首发路径引用把完整说明写进 metadata.pathReferenceText", () => {
  const attachment: TurnAttachment = {
    type: "file",
    path: "@reports/binary.bin",
    filename: "binary.bin",
  };
  const resolved = resolvedPathReferenceAttachment(attachment, "@reports/binary.bin", {
    filename: "binary.bin",
    mime: "application/octet-stream",
    sizeBytes: 12,
    source,
    reason: "binary_file",
  });
  assert.equal(resolved.contentBlock.type, "text");
  assert.equal(resolved.metadata.storageKind, "local_ref");
  assert.equal(typeof resolved.metadata.pathReferenceText, "string");
  assert.equal(resolved.metadata.pathReferenceText, resolved.contentBlock.text);
  // 不是 preview：路径引用没有文件正文预览。
  assert.equal(resolved.metadata.preview, undefined);
});

it("冷恢复逐字节还原首发说明文本（不读文件、不用 preview）", async () => {
  const attachment: TurnAttachment = { type: "file", path: "@reports/binary.bin" };
  const resolved = resolvedPathReferenceAttachment(attachment, "@reports/binary.bin", {
    filename: "binary.bin",
    mime: "application/octet-stream",
    source,
    reason: "binary_file",
  });
  const block = await filePartToContentBlock(
    storedPart({ ...resolved.metadata, preview: { text: "stale preview" } }),
    undefined,
  );
  assert.deepEqual(block, resolved.contentBlock);
  // preview 只服务 inline 文本，不能覆盖路径引用说明。
  assert.equal(block.type === "text" && block.text.includes("stale preview"), false);
});

it("旧行缺 pathReferenceText 时保持原占位行为", async () => {
  const block = await filePartToContentBlock(
    storedPart({ recoverability: "metadata_only", storageKind: "local_ref" }),
    undefined,
  );
  assert.deepEqual(block, {
    type: "text",
    text: "[Attached application/octet-stream: @reports/binary.bin]",
  });
});
