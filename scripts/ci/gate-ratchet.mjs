#!/usr/bin/env node
// 通用棘轮门禁引擎 + 三个适配器（knip / lint / format）。
//
// 背景：knip 早已配置（knip.json + package.json 的 knip script），但从未进入 CI；
// lint 与 format 同样有既有债务。三者一次性清零不现实，直接当门禁会让 CI 立刻变红并被绕过。
//
// 三个门禁的棘轮逻辑完全一致：采集 → 与基线比较 → 只对「新增」失败，允许逐步减少；
// 差别只在「怎么调用工具」和「怎么把输出变成 key」。因此这里抽出一个引擎 + 三个适配器，
// 避免三份脚本各自漂移（历史上三份脚本的指纹格式、退出码判定都出现过不一致）。
// 见 .agents/specs/upstream-code-review-parity.md 与 .agents/specs/formatting-gate.md。
//
// 统一模型：适配器产出 Map<string, number>（key → 出现次数），基线存同一模型；
// check 只对 count 上升（含基线没有的新 key）失败，count 下降只提示可以收紧基线。
// key 不含行号/列号：代码移动不会造成基线抖动，门禁不会在「只是挪了几行」的 PR 上误报。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** 基线目录。每个 gate 一个文件，便于单独迁移与审阅 diff。 */
const BASELINE_DIRNAME = ".gate-baseline";

/**
 * key 分隔符。用 NUL 因为路径、符号名、规则名都不可能包含它，拼接不会产生歧义。
 */
export const KEY_SEPARATOR = "\u0000";

/** 支持的 gate 名单，CLI 参数校验与错误提示都用它。 */
const GATES = ["knip", "lint", "format"];

// knip 的 issue 分类。除 file 外的每个字段都是列表；用列表字段名作为分类名。
// 与 knip --reporter json 的结构一一对应，新增分类时这里必须同步，否则会被静默忽略。
export const ISSUE_KINDS = [
  "binaries",
  "catalog",
  "dependencies",
  "devDependencies",
  "duplicates",
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "optionalPeerDependencies",
  "types",
  "unlisted",
  "unresolved",
];

/** 拼接统一 key：`<gate>\0<字段...>`，第一段固定是 gate，便于从基线里反解。 */
export function encodeKey(...parts) {
  return parts.join(KEY_SEPARATOR);
}

/** 从 key 反解出 gate 与其后的字段。基线只存 key，不再重复存一份拆分结果。 */
export function decodeKey(key) {
  const [gate = "", ...fields] = String(key).split(KEY_SEPARATOR);
  return { gate, fields };
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * knip：把 JSON 报告的 issues 展平成 key → 次数。
 * 同一个 issue 用 `分类 + 文件 + 符号名` 标识：不含行列号，避免无关改动导致基线抖动。
 *
 * 这里按集合语义收集（count 恒为 1）：knip 的 duplicates 会把同一个符号列进多个重复组，
 * 累计次数只会让「同一处债务」随分组重建而上涨（实测基线里 target.ts 因此虚增 21 次），
 * 既不代表新增债务，也会让迁移后的基线无法与旧指纹一一对应。
 */
export function collectKnipEntries(issues) {
  const counts = new Map();
  for (const issue of issues ?? []) {
    const file = issue?.file;
    if (typeof file !== "string" || file.length === 0) continue;
    for (const kind of ISSUE_KINDS) {
      const items = issue[kind];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const name = typeof item?.name === "string" ? item.name : "";
        counts.set(encodeKey("knip", kind, file, name), 1);
      }
    }
  }
  return counts;
}

/** 解析 knip --reporter json 的 stdout。报告缺失或不是 JSON 时抛错，不能当成「没有告警」。 */
export function parseKnipOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) throw new Error("knip 没有输出 JSON 报告，无法判定告警集合。");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`knip 输出不是合法 JSON:\n${text.slice(0, 2000)}`);
  }
  if (!Array.isArray(parsed?.issues)) throw new Error("knip 报告缺少 issues 数组。");
  return parsed.issues;
}

/**
 * 解析 oxlint --format json 的 stdout。
 *
 * 实测 oxlint 在 json reporter 下仍可能先在 stdout 打印一行人类可读文本
 * （例如 `No files found to lint. Please check your paths and ignore patterns.`），
 * 直接 JSON.parse 必然失败，所以从第一个 `{` 截取到末尾再解析。
 * 截取后仍失败就抛错：把「解析不了」静默当成 0 条，比门禁直接失败危险得多。
 */
export function parseLintOutput(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`oxlint 输出里找不到 JSON 对象:\n${text.slice(0, 2000)}`);
  const payload = text.slice(start);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `oxlint 输出不是合法 JSON（已从首个 { 截取）: ${error.message}\n${payload.slice(0, 2000)}`,
    );
  }
  if (!Array.isArray(parsed?.diagnostics)) throw new Error("oxlint 报告缺少 diagnostics 数组。");
  return parsed.diagnostics;
}

/** 同一个 (severity, code, file) 出现多次时用次数表达，避免基线存重复行。 */
export function collectLintEntries(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics ?? []) {
    const severity = typeof diagnostic?.severity === "string" ? diagnostic.severity : "unknown";
    const code = typeof diagnostic?.code === "string" ? diagnostic.code : "";
    const file = typeof diagnostic?.filename === "string" ? diagnostic.filename : "";
    bump(counts, encodeKey("lint", severity, code, file));
  }
  return counts;
}

/**
 * 解析 oxfmt --list-different 的 stdout：每行一个待格式化文件。
 *
 * 过滤 `npm ` 开头的行：通过 npx/npm 调起时，npm 会把提示写到 stdout，
 * 它们不是文件路径，留着会变成基线里的幽灵条目。
 */
export function parseFormatList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("npm "));
}

/** format 的 key 只用文件路径；一个文件最多算一条差异，次数恒为 1。 */
export function collectFormatEntries(files) {
  const counts = new Map();
  for (const file of files ?? []) counts.set(encodeKey("format", file), 1);
  return counts;
}

/**
 * 交叉校验 oxfmt 结果。
 *
 * --list-different 有差异时退出码是 1，并且每行输出一个文件。若 exit 1 却解析不到任何路径，
 * 说明输出格式变了或者被噪声吃掉；这时若把它当成「干净」，门禁会静默放行全部格式差异。
 */
export function assertFormatResultConsistent({ status, files }) {
  const list = files ?? [];
  if (status === 1 && list.length === 0)
    throw new Error(
      "oxfmt --list-different 退出码为 1（表示有差异），但没有解析出任何文件路径；拒绝把无法解析的结果当成干净。",
    );
  return list;
}

/**
 * 比较当前条目与基线，按 key 给出 regression / improvement。
 * count 上升或出现新 key → regression；count 下降或 key 消失 → improvement；相等不计。
 */
export function compareEntries(current, baseline) {
  const regressions = [];
  const improvements = [];
  const record = (list, key, currentCount, baselineCount) => {
    list.push({
      key,
      current: currentCount,
      baseline: baselineCount,
      delta: Math.abs(currentCount - baselineCount),
    });
  };
  for (const [key, currentCount] of current) {
    const baselineCount = baseline.get(key) ?? 0;
    if (currentCount > baselineCount) record(regressions, key, currentCount, baselineCount);
    else if (currentCount < baselineCount) record(improvements, key, currentCount, baselineCount);
  }
  for (const [key, baselineCount] of baseline) {
    if (current.has(key)) continue;
    if (baselineCount > 0) record(improvements, key, 0, baselineCount);
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  regressions.sort(byKey);
  improvements.sort(byKey);
  return { regressions, improvements };
}

/** 解析基线文件文本。基线只存 key 与 count，字段缺失时按「不存在」处理而不是猜。 */
export function parseBaseline(text, source = "baseline") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON: ${error.message}`);
  }
  const entries = new Map();
  for (const entry of parsed?.entries ?? []) {
    if (typeof entry?.key !== "string") continue;
    const count =
      typeof entry?.count === "number" && Number.isFinite(entry.count) ? entry.count : 1;
    entries.set(entry.key, count);
  }
  return entries;
}

/** 基线按 key 升序写入：diff 只反映增删，不反映采集顺序。 */
export function serializeBaseline(entries) {
  const sorted = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return `${JSON.stringify(
    { version: 1, entries: sorted.map(([key, count]) => ({ key, count })) },
    null,
    2,
  )}\n`;
}

/**
 * 读取基线。文件缺失时按空基线比较（= 全部条目都算新增 → FAILED），
 * 而不是直接报错：缺失基线与「基线为空」在判定上是同一件事，报 FAILED 比报工具错误更准确，
 * 也符合「首次接入某个 gate 时先看到 FAILED，再生成基线」的使用顺序。
 * 但基线文件存在却损坏时必须抛错：那可能是被截断或格式漂移，静默当成空基线会掩盖问题。
 */
async function readBaseline(cwd, gate) {
  const relative = path.join(BASELINE_DIRNAME, `${gate}.json`);
  try {
    return parseBaseline(await readFile(path.join(cwd, relative), "utf8"), relative);
  } catch (error) {
    if (error?.code === "ENOENT") {
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
 *
 * 不经过 `pnpm exec`：pnpm 会把 engine 之类的提示写到 stdout，把 JSON 报告污染成无法解析的
 * 文本，门禁于是随运行环境（node/pnpm 版本）随机失败。同理也不能直接 require.resolve
 * `knip/bin/knip.js`：这些包的 exports 不允许解析到 bin，会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 实测 oxlint→bin/oxlint、oxfmt→bin/oxfmt、knip→bin/knip.js。
 */
export function resolveToolBin(pkgName, binFileName, cwd = process.cwd()) {
  const require = createRequire(path.join(cwd, "package.json"));
  let entry;
  try {
    entry = require.resolve(pkgName);
  } catch (error) {
    throw new Error(`无法解析 ${pkgName}；请先在仓库根执行 pnpm install。(${error.message})`);
  }
  const bin = path.join(path.dirname(entry), "..", "bin", binFileName);
  if (!existsSync(bin))
    throw new Error(`找不到 ${pkgName} CLI（${bin}）；请先在仓库根执行 pnpm install。`);
  return bin;
}

/**
 * 统一执行：用 process.execPath 直接起 bin，不经过 shell 或 pnpm。
 * 只有适配器执行函数会碰 spawnSync，解析/收集/比较都是纯函数，便于单测。
 */
function runTool({ adapter, cwd, toolLabel }) {
  const bin = resolveToolBin(adapter.pkgName, adapter.binFileName, cwd);
  const result = spawnSync(process.execPath, [bin, ...adapter.args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`无法执行 ${toolLabel}: ${result.error.message}`);
  // 允许的退出码由适配器声明：knip/oxlint/oxfmt 有告警时 exit 1 属于正常路径，
  // >= 2（或不在白名单）表示工具自身失败，不能当成「没有问题」。
  if (!adapter.allowedExitCodes.includes(result.status))
    throw new Error(
      `${toolLabel} 执行失败（exit ${result.status}）:\n${result.stderr || result.stdout}`,
    );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 从 key 生成人能读的形式；报告里显示 key 原文无法判断是哪条规则。 */
function describeKey(gate, key) {
  const { fields } = decodeKey(key);
  if (gate === "knip") {
    const [kind = "", file = "", name = ""] = fields;
    return `${kind} ${file}${name ? ` :: ${name}` : ""}`;
  }
  if (gate === "lint") {
    const [severity = "", code = "", file = ""] = fields;
    return `${severity} ${code} ${file}`;
  }
  const [file = ""] = fields;
  return file;
}

/**
 * lint 的 regression 分组顺序：error 在前、warning 在后。
 * 其它 gate 没有严重级别，统一排在最前面，靠 key 排序保证稳定。
 */
function severityRank(gate, key) {
  if (gate !== "lint") return 0;
  const [severity = ""] = decodeKey(key).fields;
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

/**
 * 三个适配器：只有「怎么跑工具」和「怎么把输出变成 key」不同。
 * 命令统一为 `<gate> <check|baseline:update>`，由 main 分发。
 */
const ADAPTERS = {
  knip: {
    pkgName: "knip",
    binFileName: "knip.js",
    args: ["--reporter", "json", "--no-config-hints"],
    // knip 有告警时 exit 1；exit >= 2 才是工具失败（配置错误、依赖未安装等）。
    allowedExitCodes: [0, 1],
    collect(cwd) {
      return collectKnipEntries(
        parseKnipOutput(runTool({ adapter: this, cwd, toolLabel: "knip" }).stdout),
      );
    },
  },
  lint: {
    pkgName: "oxlint",
    binFileName: "oxlint",
    // 不带路径参数：让 oxlint 用仓库根的 .oxlintrc.json 扫全仓，避免门禁与 pnpm lint 的扫描范围漂移。
    args: ["--format", "json"],
    allowedExitCodes: [0, 1],
    collect(cwd) {
      return collectLintEntries(
        parseLintOutput(runTool({ adapter: this, cwd, toolLabel: "oxlint" }).stdout),
      );
    },
  },
  format: {
    pkgName: "oxfmt",
    binFileName: "oxfmt",
    // 只传 --list-different：实测它与 --check 互斥，同时传会报错退出。
    // 也不带路径参数，沿用 .oxfmtrc.json 的 ignorePatterns 与 .gitignore。
    args: ["--list-different"],
    allowedExitCodes: [0, 1],
    collect(cwd) {
      const result = runTool({ adapter: this, cwd, toolLabel: "oxfmt" });
      const files = parseFormatList(result.stdout);
      // 先交叉校验再收集：exit 1 但列表为空时抛错，不能静默当成干净。
      return collectFormatEntries(assertFormatResultConsistent({ status: result.status, files }));
    },
  },
};

function getAdapter(gate) {
  const adapter = ADAPTERS[gate];
  if (!adapter) throw new Error(`未知 gate: ${gate}（可用: ${GATES.join(", ")}）`);
  return adapter;
}

export function formatReport({ gate, total, baselineTotal, regressions, improvements }) {
  const sort = (items) =>
    [...items].sort(
      (a, b) => severityRank(gate, a.key) - severityRank(gate, b.key) || a.key.localeCompare(b.key),
    );
  const describe = (key) => describeKey(gate, key);
  const lines = [
    `${gate}: ${regressions.length === 0 ? "OK" : "FAILED"}`,
    `entries: ${total}`,
    `baseline: ${baselineTotal}`,
    `regressed: ${regressions.length}`,
    `improved: ${improvements.length}`,
  ];
  for (const item of sort(regressions)) lines.push(`+ ${item.delta} ${describe(item.key)}`);
  for (const item of sort(improvements)) lines.push(`- ${item.delta} ${describe(item.key)}`);
  if (regressions.length > 0)
    lines.push(
      "",
      `新增项必须消除；确认某项应长期存在时，用 node scripts/ci/gate-ratchet.mjs ${gate} baseline:update 更新基线并说明理由。`,
    );
  if (improvements.length > 0)
    lines.push("", `已消除 ${improvements.length} 条，可运行 pnpm gate:baseline 收紧基线。`);
  return lines.join("\n");
}

async function check({ gate, cwd = process.cwd() } = {}) {
  const adapter = getAdapter(gate);
  const current = adapter.collect(cwd);
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
  const current = adapter.collect(cwd);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
