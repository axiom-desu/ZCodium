/**
 * `frame-contract.js` 单测。
 *
 * 这里固定的是「本构建不支持官方 CUA 帧」的现状，**不是正确性证明**：官方 producer
 * 未随开源发布，本仓没有任何位置能产出官方帧信封，因此谓词恒为否定（false /
 * undefined / 原样返回）。若有人把恒 false 改成恒 true，这些断言会立刻失败——那会
 * 剥掉全部 MCP 文本块、伪造 attestation、并让工具结果抛错。真要支持官方 CUA，
 * 必须先按 producer 发布的信封格式实现，再同步更新本文件的断言。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
  attestOfficialCuaFrameContent,
  containsOfficialCuaImageRefCredentialText,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  preserveOfficialCuaFrameResult,
} from "../frame-contract.js";

/** 覆盖空串、普通文本、JSON 字符串、明显伪造的 image_ref 文本、prose 内嵌字段名。 */
const ANY_TEXTS = [
  "",
  "   ",
  "screenshot saved",
  '{"type":"text","text":"hello"}',
  '{"image_ref":"zcode://official-cua/authority/abc123"}',
  '{"type":"image_ref","authority":"macos-screen-1"}',
  "prose 里提到 image_ref 与 authority，但不是整块帧引用",
  "data:image/png;base64,iVBORw0KGgo=",
];

const IMAGE_BLOCK = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

const IMAGE_REF_BLOCK = {
  type: "text",
  text: '{"image_ref":"zcode://official-cua/authority/abc123"}',
};

test("isOfficialCuaImageRefText 恒为 false", () => {
  for (const text of ANY_TEXTS) {
    assert.equal(isOfficialCuaImageRefText(text), false, `text=${JSON.stringify(text)}`);
  }
});

test("containsOfficialCuaImageRefCredentialText 恒为 false", () => {
  for (const text of ANY_TEXTS) {
    assert.equal(
      containsOfficialCuaImageRefCredentialText(text),
      false,
      `text=${JSON.stringify(text)}`,
    );
  }
});

test("findOfficialCuaFrameContentPair 恒为 undefined", () => {
  // 空数组
  assert.equal(findOfficialCuaFrameContentPair([]), undefined);
  // canonical 形状的 [image, text] 也不认
  assert.equal(findOfficialCuaFrameContentPair([IMAGE_BLOCK, IMAGE_REF_BLOCK]), undefined);
  // 非数组与空值不抛错，同样是否定
  assert.equal(findOfficialCuaFrameContentPair(undefined), undefined);
  assert.equal(
    findOfficialCuaFrameContentPair({ content: [IMAGE_BLOCK, IMAGE_REF_BLOCK] }),
    undefined,
  );
});

test("preserveOfficialCuaFrameResult 原样返回同一引用", async () => {
  const result = { content: [IMAGE_BLOCK, IMAGE_REF_BLOCK], isError: false };
  const preserved = await preserveOfficialCuaFrameResult(result);
  assert.equal(preserved, result);
  assert.equal(preserved.content, result.content);

  const withoutOptions = await preserveOfficialCuaFrameResult(result, {
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  });
  assert.equal(withoutOptions, result);

  const empty = { content: [] };
  assert.equal(await preserveOfficialCuaFrameResult(empty), empty);
});

test("attestOfficialCuaFrameContent 恒为 undefined", () => {
  assert.equal(attestOfficialCuaFrameContent(undefined), undefined);
  assert.equal(
    attestOfficialCuaFrameContent([IMAGE_BLOCK, IMAGE_REF_BLOCK], "official_cua_frame_v1"),
    undefined,
  );
  assert.equal(
    attestOfficialCuaFrameContent([IMAGE_BLOCK, IMAGE_REF_BLOCK], "any-kind"),
    undefined,
  );
});

test("常量值是协议约定，不可随意改动", () => {
  assert.equal(OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION, "official_cua_frame_v1");
  assert.equal(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES, 200 * 1024);
  assert.equal(OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY, "zcode.cua/official-frame-integrity-v1");
});
