import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// App control 的 SHA-256 幂等身份是 Host 实现；根 barrel 泄露 factory 会让共享 UI
// 在启动前就因 node:crypto 无法打包。直接验证公开 browser 入口，不能 external Node 来假通过。
test("the public services entry bundles for browsers without Node builtins", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    platform: "browser",
    format: "esm",
    bundle: true,
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.outputFiles.length > 0);
  assert.doesNotMatch(result.outputFiles[0]!.text, /from ["']node:/u);
});
