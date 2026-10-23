import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { exportSurface } from "./public-export-surface.js";

// 契约拆分回归：工作树公开导出面必须与 Git HEAD 基线一致。
// 基线由同一解析器从 HEAD 源码生成（命令见 .agents/specs/lint-contract-slice.md），
// 防止拆分中新增/丢失/改名导出，或把 type-only 导出误改成值导出。
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, "../src");
const FIXTURE = path.join(TEST_DIR, "fixtures/public-export-surface.json");

describe("public export surface · 拆分前后契约不变", () => {
  it("工作树导出面与 Git HEAD 基线一致", () => {
    const baseline = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as ReturnType<
      typeof exportSurface
    >;
    assert.deepEqual(exportSurface(SRC_ROOT), baseline);
  });
});
