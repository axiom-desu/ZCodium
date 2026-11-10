import { defineConfig } from "tsup";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const { collectRollingAppVersion } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/rolling-app-version.mjs")).href
);
const { appVersion } = collectRollingAppVersion();
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

export const SERVER_CLI_DEFINES = {
  // 与 Desktop 共用根版本派生源，不能让未注入的 0.0.0-dev 被严格兼容门禁拒绝。
  __ZCODE_VERSION__: JSON.stringify(appVersion),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

export default defineConfig({
  entry: {
    "server-cli": "src/main.ts",
    "server-core": "src/server-core/entry.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  // node:sqlite 只能带 node: 前缀；tsup 默认剥掉后会被误当成 npm sqlite 包。
  removeNodeProtocol: false,
  sourcemap: true,
  splitting: false,
  banner: {
    js: 'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; import { dirname as __zcodeDirname } from "node:path"; const __filename = __zcodeFileURLToPath(import.meta.url); const __dirname = __zcodeDirname(__filename);',
  },
  noExternal: ["@zcode/shared", "@zcode/rpc", "@zcode/services"],
  define: SERVER_CLI_DEFINES,
  external: [
    // zip 库是 CJS，内联到 ESM 会生成不能执行的 dynamic require("fs")。
    "yazl",
    "yauzl",
    "node-pty",
    "ssh2",
    "yaml",
    "node-forge",
    "undici",
    "axios",
    "form-data",
    "combined-stream",
    "proxy-from-env",
    "follow-redirects",
    "@lydell/node-pty-darwin-arm64",
    "@lydell/node-pty-darwin-x64",
    "@lydell/node-pty-linux-arm64",
    "@lydell/node-pty-linux-x64",
  ],
});
