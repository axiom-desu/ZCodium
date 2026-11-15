import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 当前源码才是测试入口：不能让 Vitest 的子串过滤器匹配 .cache 里的上游参考树或 dist 副本。
// 两种 runner 分开，未知测试格式失败；不得用 UI doubles 替代 worktree/SQLite/准入负向回归。
const root = resolve(import.meta.dirname, "../..");
const roots = [
  join(root, "packages/services/test"),
  join(root, "packages/services/src/extensions"),
];
const groups = { node: [], vitest: [] };

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "dist-types", ".cache"].includes(entry.name)) {
        await discover(path);
      }
    } else if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/u.test(entry.name)) {
      const source = await readFile(path, "utf8");
      const node = /from\s+["']node:test["']/u.test(source);
      const vitest = /from\s+["']vitest["']/u.test(source);
      if (node === vitest) throw new Error(`Unknown or mixed services test runner: ${path}`);
      groups[node ? "node" : "vitest"].push(path);
    }
  }
}

function run(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Services tests terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

for (const directory of roots) await discover(directory);
if (!groups.node.length || !groups.vitest.length) throw new Error("Services test groups are empty");

// 这是已安装工具缓存，不是用户配置；先保存位置，再给所有被测进程隔离 HOME/XDG。
const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
const corepackCache = process.env.COREPACK_HOME ?? join(homedir(), ".cache/node/corepack");
const temporary = await mkdtemp(join(tmpdir(), "zcode-services-safety-"));
try {
  const dirs = Object.fromEntries(
    ["home", "config", "data", "cache", "tmp"].map((name) => [name, join(temporary, name)]),
  );
  await Promise.all(Object.values(dirs).map((directory) => mkdir(directory)));
  const env = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp,
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
    COREPACK_HOME: corepackCache,
  };
  console.log(
    `Services safety: Node ${process.version}; ${groups.node.length} node:test files, ${groups.vitest.length} Vitest files`,
  );
  const node = await run(
    ["--import", "tsx", "--test", "--test-isolation=none", ...groups.node],
    env,
  );
  const vitest = await run(
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "packages/ui/vitest.config.ts",
      "--maxWorkers",
      "3",
      "--exclude",
      ".cache/**",
      "--exclude",
      "**/dist/**",
      "--exclude",
      "**/dist-types/**",
      ...groups.vitest,
    ],
    env,
  );
  process.exitCode = node || vitest;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
