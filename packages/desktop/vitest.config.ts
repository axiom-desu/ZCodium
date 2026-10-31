import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Desktop 集成测试（如 test/sourceAuthorityLoopback.test.ts）会加载 @zcode/ui 源码：
// UI 包内部统一用 `@` 别名指向 packages/ui/src，运行这类跨包集成用例时必须镜像同一别名，
// 否则 UI 源码内部的 `@/...` 依赖无法解析。这里只补别名，不复制 UI 实现、不改 UI 包配置。
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../ui/src", import.meta.url)) } },
});
