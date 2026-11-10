import { createRequire } from "node:module";
import { resolve } from "node:path";

// ConversationComposer 手机焦点夹具的构建助手（只被 composer-mobile-focus-smoke.mjs 使用）。
// 复用现有 Web profile 手机夹具的 CSS/临时目录/真实入口 helper，不修改共用模块。
//
// 唯一额外处理：ConversationComposer 的静态 import 链会带进 pdf.js worker / xlsx wasm 的
// `?url` 资源导入（Vite 原生支持，esbuild 不认识）。这里用 scoped 插件把 `?url` 解析到
// 独立 namespace 并返回一个假的 data URL：重资源在焦点用例里从不被加载/调用，
// 只是让 bundle 能产出，不能借机替换掉被测组件的真实依赖。
const ASSET_URL_NAMESPACE = "zcode-test-asset-url";
const TEST_ASSET_URL = "data:text/plain,zcode-test-asset-url";

function testAssetUrlPlugin() {
  return {
    name: "zcode-test-asset-url",
    setup(build) {
      build.onResolve({ filter: /\?url$/ }, (args) => ({
        path: args.path,
        namespace: ASSET_URL_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: ASSET_URL_NAMESPACE }, () => ({
        contents: `export default ${JSON.stringify(TEST_ASSET_URL)};`,
        loader: "js",
      }));
    },
  };
}

export async function buildComposerFocusFixtureScript(root, cacheDir) {
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [
      resolve(root, "packages/ui/test/fixtures/conversation-composer-mobile-focus.jsx"),
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "composer-mobile-focus-fixture"),
    alias: {
      "@": resolve(root, "packages/ui/src"),
    },
    plugins: [testAssetUrlPlugin()],
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".wasm": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("ConversationComposer mobile focus fixture was not built");
  return script;
}
