#!/usr/bin/env node
// knip 棘轮门禁。
//
// 背景：knip 早已配置（knip.json + package.json 的 knip script），但从未进入 CI。
// 上游 code review 报告 §5.2 把这一点写成「已配置但未在 CI 执行」，本仓库同样如此。
// 见 .agents/specs/upstream-code-review-parity.md。
//
// 为什么不直接跑 `knip`：当前基线有千余条既有告警（未用导出 510、未用类型 283、
// 未用文件 161 等），一次性清零不现实，直接作为门禁会让 CI 立刻变红并被绕过。
//
// 因此采用与 scripts/architecture/architecture-check.mjs 相同的棘轮：把既有告警按
// 稳定指纹存入 .knip-baseline.json，门禁只对「新增」告警失败，允许逐步减少。
// 指纹不含行号/列号，代码移动不会造成基线抖动。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const BASELINE_FILENAME = ".knip-baseline.json";

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

/**
 * 指纹分隔符。用 NUL 因为路径与符号名都不可能包含它，拼接不会产生歧义。
 */
const FINGERPRINT_SEPARATOR = "\u0000";

export function encodeFingerprint(kind, file, name) {
  return [kind, file, name].join(FINGERPRINT_SEPARATOR);
}

/** 从指纹反解出分类/文件/符号名。基线只存指纹，三者不再重复存一份。 */
export function decodeFingerprint(fingerprint) {
  const [kind = "", file = "", name = ""] = fingerprint.split(FINGERPRINT_SEPARATOR);
  return { fingerprint, kind, file, name };
}

/**
 * 把 knip JSON 报告的 issues 展平成稳定的指纹集合。
 * 同一个 issue 用 `分类 + 文件 + 符号名` 标识：不含行列号，避免无关改动导致基线抖动。
 */
export function collectFingerprints(issues) {
  const entries = new Map();
  for (const issue of issues ?? []) {
    const file = issue?.file;
    if (typeof file !== "string" || file.length === 0) continue;
    for (const kind of ISSUE_KINDS) {
      const items = issue[kind];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const name = typeof item?.name === "string" ? item.name : "";
        const fingerprint = encodeFingerprint(kind, file, name);
        entries.set(fingerprint, { fingerprint, kind, file, name });
      }
    }
  }
  return entries;
}

/** 比较当前告警与基线：只返回新增与已消除，供门禁判定与提示。 */
export function compareFingerprints(current, baseline) {
  const added = [];
  const removed = [];
  for (const [fingerprint, entry] of current) if (!baseline.has(fingerprint)) added.push(entry);
  for (const [fingerprint, entry] of baseline) if (!current.has(fingerprint)) removed.push(entry);
  const byFingerprint = (a, b) => a.fingerprint.localeCompare(b.fingerprint);
  added.sort(byFingerprint);
  removed.sort(byFingerprint);
  return { added, removed };
}

export function formatReport({ added, removed, total, baselineTotal }) {
  const lines = [
    `knip: ${added.length === 0 ? "OK" : "FAILED"}`,
    `issues: ${total}`,
    `baseline: ${baselineTotal}`,
    `new: ${added.length}`,
    `resolved: ${removed.length}`,
  ];
  for (const item of added)
    lines.push(`+ ${item.kind} ${item.file}${item.name ? ` :: ${item.name}` : ""}`);
  if (added.length > 0)
    lines.push(
      "",
      "新增告警必须消除；确认某项应长期存在时，用 pnpm knip:baseline 更新基线并说明理由。",
    );
  if (removed.length > 0)
    lines.push("", `已消除 ${removed.length} 条，可运行 pnpm knip:baseline 收紧基线。`);
  return lines.join("\n");
}

async function readBaseline(cwd) {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, BASELINE_FILENAME), "utf8"));
    const map = new Map();
    for (const fingerprint of parsed?.fingerprints ?? []) {
      if (typeof fingerprint === "string") map.set(fingerprint, decodeFingerprint(fingerprint));
    }
    return map;
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(`缺少 ${BASELINE_FILENAME}；先运行 pnpm knip:baseline 生成基线。`);
    throw error;
  }
}

// 基线只存指纹列表：kind/file/name 都能从指纹反解，不重复存一份，避免字段与指纹漂移。
async function writeBaseline(cwd, current) {
  const fingerprints = [...current.keys()].sort((a, b) => a.localeCompare(b));
  await writeFile(
    path.join(cwd, BASELINE_FILENAME),
    `${JSON.stringify({ version: 1, fingerprints }, null, 2)}\n`,
  );
  return fingerprints;
}

/**
 * 定位 knip 的 CLI 入口。
 *
 * 不经过 `pnpm exec`：pnpm 会把 engine 之类的提示写到 stdout，把 JSON 报告污染成无法解析的
 * 文本，门禁于是随运行环境（node/pnpm 版本）随机失败。knip 的 `exports` 不允许直接解析
 * `knip/bin/knip.js`，所以先解析包入口，再回推 bin。
 */
export function resolveKnipBin(cwd = process.cwd()) {
  const require = createRequire(path.join(cwd, "package.json"));
  const entry = require.resolve("knip");
  const bin = path.join(path.dirname(entry), "..", "bin", "knip.js");
  if (!existsSync(bin))
    throw new Error(`找不到 knip CLI（${bin}）；请先在仓库根执行 pnpm install。`);
  return bin;
}

/** 运行 knip 并解析 JSON 报告。knip 有告警时退出码为 1，这属于正常路径。 */
function runKnip(cwd) {
  const result = spawnSync(
    process.execPath,
    [resolveKnipBin(cwd), "--reporter", "json", "--no-config-hints"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // 退出码 >= 2 表示 knip 自身失败（配置错误、依赖未安装等），不能当成「没有告警」。
  if (result.error) throw new Error(`无法执行 knip: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`knip 执行失败（exit ${result.status}）:\n${result.stderr || result.stdout}`);
  const stdout = (result.stdout ?? "").trim();
  if (stdout.length === 0) throw new Error("knip 没有输出 JSON 报告，无法判定告警集合。");
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`knip 输出不是合法 JSON:\n${stdout.slice(0, 2000)}`);
  }
  if (!Array.isArray(parsed?.issues)) throw new Error("knip 报告缺少 issues 数组。");
  return parsed.issues;
}

export async function check({ cwd = process.cwd() } = {}) {
  const issues = runKnip(cwd);
  const current = collectFingerprints(issues);
  const baseline = await readBaseline(cwd);
  const { added, removed } = compareFingerprints(current, baseline);
  return { current, baseline, added, removed, total: current.size, baselineTotal: baseline.size };
}

export async function update({ cwd = process.cwd() } = {}) {
  const issues = runKnip(cwd);
  const current = collectFingerprints(issues);
  const fingerprints = await writeBaseline(cwd, current);
  return { total: fingerprints.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] ?? "check";
  const cwd = process.cwd();
  try {
    if (command === "baseline:update") {
      const { total } = await update({ cwd });
      console.log(`knip baseline updated: ${total} issues -> ${BASELINE_FILENAME}`);
    } else if (command === "check") {
      const result = await check({ cwd });
      console.log(formatReport(result));
      process.exit(result.added.length === 0 ? 0 : 1);
    } else {
      console.error(`未知命令: ${command}（可用: check, baseline:update）`);
      process.exit(2);
    }
  } catch (error) {
    console.error(`knip ratchet: ${error.message}`);
    process.exit(2);
  }
}
