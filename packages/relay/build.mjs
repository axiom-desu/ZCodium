// 把 relay 打成单文件（esbuild，平台 node）：产物不依赖 @zcode/shared 的运行时解析，
// 用户机器上 `node dist/cli.mjs` 即可运行，无需构建工具链。
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
