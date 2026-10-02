import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli.js";
import { resolveBundledAgentWiring } from "./runtime/agentWiring.js";
import { migrateLegacyUserDataRoot } from "@zcode/shared/node";

// 自动接线只作为本次 CLI 的显式依赖传入，不能污染全局 env；candidate release 启动时
// Supervisor 会按 candidate runtime 重新计算，避免继承旧 release 的 zcode.cjs。
const bundledAgentWiring = await resolveBundledAgentWiring(
  dirname(fileURLToPath(import.meta.url)),
  process.env,
);

// 用户级数据根从 `.zcodium` 让位给 `.zcodium-exp`（ZCodium-project/ZCodium 的 #13/#17
// 正把 `~/.zcodium` 收敛为它们的数据根，两个产品不能共用同一棵树）。常量改名后新构建
// 只读新根，不搬一次则存量用户的凭据/配置/会话留在旧根，表现为要重新登录、绑定丢失。
// baseDir 与 runtime/paths.ts 的解析保持一致：env 优先，否则 HOME。
// 失败不抛：启动阶段抛异常会让进程起不来，比数据没搬严重得多。
migrateLegacyUserDataRoot({
  baseDir: process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir(),
});

void runServerCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (prompt) => {
      process.stdout.write(prompt);
      return await new Promise<string>((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    },
  },
  { bundledAgentWiring },
).then((exitCode) => {
  process.exitCode = exitCode;
});
