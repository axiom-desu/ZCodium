import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stageCuaDriverRuntimeFiles } from "../../../../../scripts/cua-driver-runtime-assets.mjs";

const packageRoot = resolve(import.meta.dirname, "..");

// 见 browser-use-plugin/scripts/build.mjs 的同名修复：esbuild 的 esm 产物里
// __require shim 在 ESM 作用域没有 require 可用，@zcode/core 拖进来的 CJS 依赖（yaml →
// require("process")）会在**模块求值阶段**抛错，plugin host 的 await import() 直接失败，
// 表现为注册 0 个工具、模型侧完全看不到 mcp__node_repl__js。注入真实 createRequire。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    external: ["@trycua/cua-driver"],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  // 兼容层 GJS helper 是外部脚本（gjs 运行）与 Shell 扩展，不参与 esbuild 打包；
  // 但 helper-client 以 `new URL("./helper/cua-wayland-input.js", import.meta.url)` 定位它，
  // bundle 部署后 import.meta.url 指向 dist/mcp/server.js，所以必须整目录拷到 dist/mcp/helper/。
  const cuaHelperDirSource = resolve(
    packageRoot,
    "../../../..",
    "packages",
    "zcode-cua",
    "compatible",
    "helper",
  );
  const cuaHelperDirTarget = resolve(dirname(outfile), "helper");
  await mkdir(cuaHelperDirTarget, { recursive: true });
  await cp(cuaHelperDirSource, cuaHelperDirTarget, { recursive: true });
  await stageCuaDriverRuntimeFiles(dirname(outfile));
  return { outfile };
};

// 这里原先写成 `file://${process.argv[1]}`。
// Windows 上 argv[1] 是 `C:\...\build.mjs`，而 import.meta.url 是 `file:///C:/.../build.mjs`，
// 两者永远不相等 —— 脚本被当成纯模块导入，什么都不做就退出：构建"成功"却没有产物，
// 直到 dev 守卫报「build succeeded without required MCP runtime」才暴露。
// browser-use 的同名脚本与仓库其他入口都用 pathToFileURL，抽包时我漏了这一处。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
