#!/usr/bin/env node
// 通用棘轮门禁引擎 + 三个适配器（knip / lint / format）。
//
// 三个门禁的棘轮逻辑完全一致：采集 → 与基线比较 → 只对「新增」失败，允许逐步减少；
// 差别只在「怎么调用工具」和「怎么把输出变成 key」。纯解析与比较在 gate-ratchet-core.mjs，
// 这里只负责进程 IO、基线读写与 CLI 分发；不是第二套引擎。见 .agents/specs/quality-gates.md。
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertFormatResultConsistent,
  collectFormatEntries,
  collectKnipEntries,
  collectLintEntries,
  compareEntries,
  formatReport,
  parseBaseline,
  parseFormatList,
  parseKnipOutput,
  parseLintOutput,
  serializeBaseline,
} from "./gate-ratchet-core.mjs";

export * from "./gate-ratchet-core.mjs";

/** 基线目录。每个 gate 一个文件，便于单独迁移与审阅 diff。 */
const BASELINE_DIRNAME = ".gate-baseline";

/** 支持的 gate 名单，CLI 参数校验与错误提示都用它。 */
const GATES = ["knip", "lint", "format"];

/**
 * 读取基线。文件缺失按空基线比较（首次接入时先看到 FAILED，再生成基线）；
 * 文件存在却损坏必须抛错，否则截断或格式漂移会被当成「债务已清零」。
 */
async function readBaseline(cwd, gate, { hint = true } = {}) {
  const relative = path.join(BASELINE_DIRNAME, `${gate}.json`);
  try {
    return parseBaseline(await readFile(path.join(cwd, relative), "utf8"), {
      gate,
      source: relative,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (hint)
        console.error(
          `缺少 ${relative}，按空基线比较；确认当前结果后运行 node scripts/ci/gate-ratchet.mjs ${gate} baseline:update 生成基线。`,
        );
      return new Map();
    }
    throw error;
  }
}

async function writeBaseline(cwd, gate, entries) {
  const relative = path.join(BASELINE_DIRNAME, `${gate}.json`);
  await mkdir(path.join(cwd, BASELINE_DIRNAME), { recursive: true });
  await writeFile(path.join(cwd, relative), serializeBaseline(entries));
  return relative;
}

/**
 * 定位工具的 CLI 入口：先解析包入口，再回推 <pkg>/bin/<binFileName>。
 * 不经过 `pnpm exec`（提示会污染 stdout），也不能 require.resolve bin（exports 不允许）。
 */
export async function resolveToolBin(pkgName, binFileName, cwd = process.cwd()) {
  const require = createRequire(path.join(cwd, "package.json"));
  let entry;
  try {
    entry = require.resolve(pkgName);
  } catch (error) {
    throw new Error(`无法解析 ${pkgName}；请先在仓库根执行 pnpm install。(${error.message})`);
  }
  const bin = path.join(path.dirname(entry), "..", "bin", binFileName);
  try {
    await access(bin);
  } catch {
    throw new Error(`找不到 ${pkgName} CLI（${bin}）；请先在仓库根执行 pnpm install。`);
  }
  return bin;
}

/**
 * 统一执行：用 process.execPath 直接起 bin，不经过 shell 或 pnpm。
 * 允许的退出码由适配器声明；>= 2 或信号表示工具自身失败，不能当成「没有问题」。
 */
async function runTool({ adapter, cwd, toolLabel }) {
  const bin = await resolveToolBin(adapter.pkgName, adapter.binFileName, cwd);
  const result = spawnSync(process.execPath, [bin, ...adapter.args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`无法执行 ${toolLabel}: ${result.error.message}`);
  const signal = result.signal ? `, signal ${result.signal}` : "";
  if (!adapter.allowedExitCodes.includes(result.status))
    throw new Error(
      `${toolLabel} 执行失败（exit ${result.status}${signal}）:\n${result.stderr || result.stdout}`,
    );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 三个适配器：只有「怎么跑工具」和「怎么把输出变成 key」不同。 */
const ADAPTERS = {
  knip: {
    pkgName: "knip",
    binFileName: "knip.js",
    args: ["--reporter", "json", "--no-config-hints"],
    allowedExitCodes: [0, 1],
    async collect(cwd) {
      return collectKnipEntries(
        parseKnipOutput((await runTool({ adapter: this, cwd, toolLabel: "knip" })).stdout),
      );
    },
  },
  lint: {
    pkgName: "oxlint",
    binFileName: "oxlint",
    // 不带路径参数：沿用仓库根 .oxlintrc.json，避免门禁与 pnpm lint 的扫描范围漂移。
    args: ["--format", "json"],
    allowedExitCodes: [0, 1],
    async collect(cwd) {
      const { stdout } = await runTool({ adapter: this, cwd, toolLabel: "oxlint" });
      return collectLintEntries(parseLintOutput(stdout).diagnostics);
    },
  },
  format: {
    pkgName: "oxfmt",
    binFileName: "oxfmt",
    // 只传 --list-different：实测与 --check 互斥。也不带路径参数，沿用 .oxfmtrc.json。
    args: ["--list-different"],
    allowedExitCodes: [0, 1],
    async collect(cwd) {
      const result = await runTool({ adapter: this, cwd, toolLabel: "oxfmt" });
      const files = parseFormatList(result.stdout);
      return collectFormatEntries(assertFormatResultConsistent({ status: result.status, files }));
    },
  },
};

function getAdapter(gate) {
  const adapter = ADAPTERS[gate];
  if (!adapter) throw new Error(`未知 gate: ${gate}（可用: ${GATES.join(", ")}）`);
  return adapter;
}

async function check({ gate, cwd = process.cwd() } = {}) {
  const adapter = getAdapter(gate);
  const current = await adapter.collect(cwd);
  const baseline = await readBaseline(cwd, gate);
  const { regressions, improvements } = compareEntries(current, baseline);
  return {
    gate,
    current,
    baseline,
    regressions,
    improvements,
    total: current.size,
    baselineTotal: baseline.size,
  };
}

async function update({ gate, cwd = process.cwd() } = {}) {
  const adapter = getAdapter(gate);
  // 先校验已存在的基线：损坏时必须在写文件前 exit 2，否则一次 update 会把损坏/旧版基线静默抹掉。
  await readBaseline(cwd, gate, { hint: false });
  const current = await adapter.collect(cwd);
  const file = await writeBaseline(cwd, gate, current);
  return { gate, total: current.size, file };
}

async function main(argv) {
  const [gate, command = "check"] = argv;
  const cwd = process.cwd();
  if (!gate || !GATES.includes(gate)) {
    console.error(`未知 gate: ${gate ?? ""}（可用: ${GATES.join(", ")}）`);
    return 2;
  }
  try {
    if (command === "baseline:update") {
      const { total, file } = await update({ gate, cwd });
      console.log(`${gate} baseline updated: ${total} entries -> ${file}`);
      return 0;
    }
    if (command !== "check") {
      console.error(`未知命令: ${command}（可用: check, baseline:update）`);
      return 2;
    }
    const result = await check({ gate, cwd });
    console.log(formatReport(result));
    return result.regressions.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`${gate} ratchet: ${error.message}`);
    return 2;
  }
}

/**
 * CLI 入口判定必须是 URL 比较，不能是 `file://${argv[1]}`：
 * 实测含空格路径时前者得到 file:///tmp/a%20b，后者得到 file:///tmp/a b，守卫不命中，
 * main 不执行却 exit 0。pathToFileURL 同时处理中文与百分号编码。
 */
export function isMainModule(moduleUrl, entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return false;
  return moduleUrl === pathToFileURL(path.resolve(entryPath)).href;
}

try {
  if (isMainModule(import.meta.url, process.argv[1]))
    process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`gate-ratchet 入口判定失败: ${error.message}`);
  process.exit(2);
}
