// gate-ratchet 的纯解析与比较层：只做数据变换，不做文件/进程 IO，便于单测与复用。
// 进程执行、基线读写、CLI 分发在 gate-ratchet.mjs；不是第二套引擎。
import path from "node:path";

/** key 分隔符。路径、符号名、规则名都不可能包含 NUL，拼接不会产生歧义。 */
export const KEY_SEPARATOR = "\u0000";

// knip json reporter 的分类列表（node_modules/knip/dist/reporters/json.js）。
// 新增分类时这里必须同步，否则该类告警会被静默忽略或误报未知分类。
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
  "nsExports",
  "nsTypes",
  "optionalPeerDependencies",
  "types",
  "unlisted",
  "unresolved",
];

// 基线的 key 形状与路径所在段：knip/lint 各 3 段，format 1 段；knip/format 是集合语义。
const KEY_SHAPES = {
  knip: { fields: 3, pathIndex: 1, singleton: true },
  lint: { fields: 3, pathIndex: 2, singleton: false },
  format: { fields: 1, pathIndex: 0, singleton: true },
};
const BASELINE_FIELDS = new Set(["version", "entries"]);
const ENTRY_FIELDS = new Set(["key", "count"]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function assertKnownFields(record, allowed, label) {
  for (const key of Object.keys(record))
    if (!allowed.has(key)) throw new Error(`${label} 含未知字段 ${key}，拒绝静默忽略。`);
}

/** 拼接统一 key：`<gate>\0<字段...>`，第一段固定是 gate，便于从基线里反解。 */
export function encodeKey(...parts) {
  return parts.join(KEY_SEPARATOR);
}

/** 从 key 反解出 gate 与其后的字段。基线只存 key，不再重复存一份拆分结果。 */
export function decodeKey(key) {
  const [gate = "", ...fields] = String(key).split(KEY_SEPARATOR);
  return { gate, fields };
}

/** UTF-16 码元字典序比较：baseline 写入与报告排序都只由码元决定，不受 ICU/locale 影响。 */
export function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 把采集到的路径归一成仓库根相对的正斜杠形式。
 * 反斜杠来自 Windows 工具输出；`path.posix.normalize` 会静默折叠 `..`，所以归一后必须显式拒绝逃逸。
 * 不做大小写折叠：Linux 上 a.ts 与 A.ts 是两个不同文件。
 */
export function normalizeRepoPath(value, label = "路径") {
  const raw = typeof value === "string" ? value : "";
  if (raw.length === 0) throw new Error(`${label} 为空，必须是仓库根相对路径。`);
  const slashed = raw.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashed);
  const escaped =
    slashed.startsWith("/") ||
    /^[A-Za-z]:/.test(slashed) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/");
  if (escaped) throw new Error(`${label} 必须是未逃逸的仓库相对路径: ${raw}`);
  return normalized;
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function knipItemName(item, kind, file) {
  if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0)
    throw new Error(`knip ${kind} 条目缺少非空 name 字符串（${file}）。`);
  return item.name;
}

/**
 * knip：把 JSON 报告的 issues 展平成 key → 次数。
 * 未知分类、缺 file、坏条目都必须抛错：静默跳过等于让 knip 升级后的新告警直接放行。
 * duplicates 在真实输出里是「组 → 成员」的嵌套数组；沿用既有「每个文件一条」的 key 形状，
 * 以免改动 1141 条基线，但其成员形状仍需校验。owners 是 json reporter 的元数据，不是分类。
 */
export function collectKnipEntries(issues) {
  if (!Array.isArray(issues)) throw new Error("knip issues 不是数组。");
  const counts = new Map();
  for (const issue of issues) {
    if (!isRecord(issue)) throw new Error("knip issue 条目不是对象。");
    const file = normalizeRepoPath(issue.file, "knip issue.file");
    for (const [kind, items] of Object.entries(issue)) {
      if (kind === "file") continue;
      if (!Array.isArray(items)) throw new Error(`knip 分类 ${kind} 不是数组（${file}）。`);
      if (kind === "owners") continue;
      if (!ISSUE_KINDS.includes(kind))
        throw new Error(`knip 报告出现未知分类 ${kind}（${file}），拒绝静默忽略。`);
      if (kind === "duplicates") {
        for (const group of items) {
          if (!Array.isArray(group))
            throw new Error(`knip duplicates 分组不是数组（${file}），拒绝静默忽略。`);
          for (const member of group) knipItemName(member, kind, file);
        }
        if (items.length > 0) counts.set(encodeKey("knip", kind, file, ""), 1);
        continue;
      }
      for (const item of items)
        counts.set(encodeKey("knip", kind, file, knipItemName(item, kind, file)), 1);
    }
  }
  return counts;
}

/** 解析 knip --reporter json 的 stdout。缺失或不是 JSON 时抛错，不能当成「没有告警」。 */
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
 * 实测 oxlint 在 json reporter 下仍可能先打印人类可读文本（如 `No files found to lint...`），
 * 因此从第一个 `{` 截取。实测空目录下报告 `number_of_files: 0` + exit 1；若接受它，
 * 空 diagnostics 会被判定为 OK 或大批 improvement，是最危险的静默放行。
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
  const numberOfFiles = parsed.number_of_files;
  if (!Number.isSafeInteger(numberOfFiles) || numberOfFiles < 1)
    throw new Error(
      `oxlint 报告 number_of_files=${String(numberOfFiles)}，必须是正整数；扫描 0 文件或报告缺字段时拒绝判定。`,
    );
  return { diagnostics: parsed.diagnostics, numberOfFiles };
}

/**
 * 同一个 (severity, code, file) 出现多次时用次数表达。
 * severity/code/filename 必须可理解：缺字段的历史实现会生成 `lint\0unknown\0\0` 幽灵 key。
 */
export function collectLintEntries(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics ?? []) {
    if (!isRecord(diagnostic)) throw new Error("oxlint 诊断条目不是对象。");
    const { severity, code, filename } = diagnostic;
    if (severity !== "error" && severity !== "warning")
      throw new Error(`oxlint 诊断 severity 无法识别: ${String(severity)}。`);
    if (typeof code !== "string" || code.length === 0)
      throw new Error(`oxlint 诊断缺少 code（${String(filename ?? "")}）。`);
    if (typeof filename !== "string" || filename.length === 0)
      throw new Error("oxlint 诊断缺少 filename。");
    bump(
      counts,
      encodeKey("lint", severity, code, normalizeRepoPath(filename, "oxlint diagnostic filename")),
    );
  }
  return counts;
}

/**
 * 解析 oxfmt --list-different 的 stdout：每行一个待格式化文件。
 * 过滤 `npm ` 开头的行：通过 npx/npm 调起时 npm 的提示不是文件路径，留着会变成幽灵条目。
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
  for (const file of files ?? [])
    counts.set(encodeKey("format", normalizeRepoPath(file, "oxfmt 文件路径")), 1);
  return counts;
}

/**
 * 交叉校验 oxfmt 结果：exit 1 表示有差异，却解析不到任何路径时说明输出格式变了，
 * 不能把它当成「干净」而静默放行全部格式差异。
 */
export function assertFormatResultConsistent({ status, files }) {
  const list = files ?? [];
  if (status === 1 && list.length === 0)
    throw new Error(
      "oxfmt --list-different 退出码为 1（表示有差异），但没有解析出任何文件路径；拒绝把无法解析的结果当成干净。",
    );
  return list;
}

/** 比较当前条目与基线：count 上升或新 key → regression；下降或消失 → improvement。 */
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
  const byKey = (a, b) => compareCodePoints(a.key, b.key);
  regressions.sort(byKey);
  improvements.sort(byKey);
  return { regressions, improvements };
}

function validateKeyFields(gate, fields, label) {
  if (gate === "lint") {
    if (fields[0] !== "error" && fields[0] !== "warning")
      throw new Error(`${label}.key severity 必须是 error 或 warning。`);
    if (!fields[1]) throw new Error(`${label}.key code 不能为空。`);
  }
  if (gate === "knip") {
    if (!ISSUE_KINDS.includes(fields[0]))
      throw new Error(`${label}.key 分类未知: ${String(fields[0])}。`);
    // duplicates 是组语义，历史基线用空 name 表示「该文件存在重复组」。
    if (fields[0] !== "duplicates" && !fields[2]) throw new Error(`${label}.key name 不能为空。`);
  }
}

/**
 * 解析基线文件文本：version/entries/每项 key 与 count 都必须合法，否则抛错。
 * 缺失文件是「空基线」（由 readBaseline 处理），但文件存在却结构不对时必须 exit 2：
 * 静默当成空基线会让全部存量债务变成 improvement 后放行。
 */
export function parseBaseline(text, { gate, source = "baseline" } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${source} 顶层必须是对象。`);
  assertKnownFields(parsed, BASELINE_FIELDS, source);
  if (parsed.version !== 1)
    throw new Error(`${source} version 必须是 1，收到 ${String(parsed.version)}。`);
  if (!Array.isArray(parsed.entries)) throw new Error(`${source} entries 必须是数组。`);
  const shape = KEY_SHAPES[gate];
  if (!shape) throw new Error(`未知 gate: ${String(gate)}`);
  const entries = new Map();
  for (const [index, entry] of parsed.entries.entries()) {
    const label = `${source} entries[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} 必须是对象。`);
    assertKnownFields(entry, ENTRY_FIELDS, label);
    if (typeof entry.key !== "string" || entry.key.length === 0)
      throw new Error(`${label}.key 必须是非空字符串。`);
    const { gate: keyGate, fields } = decodeKey(entry.key);
    if (keyGate !== gate || fields.length !== shape.fields)
      throw new Error(
        `${label}.key 段数与 gate 不匹配（需要 ${gate} + ${shape.fields} 段）: ${entry.key}`,
      );
    validateKeyFields(gate, fields, label);
    const fileField = fields[shape.pathIndex];
    if (normalizeRepoPath(fileField, `${label}.key 路径`) !== fileField)
      throw new Error(`${label}.key 路径不是规范仓库相对形式: ${fileField}`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 1)
      throw new Error(`${label}.count 必须是正整数: ${String(entry.count)}。`);
    if (shape.singleton && entry.count !== 1)
      throw new Error(`${label}.count 在 ${gate} 必须为 1: ${entry.count}。`);
    if (entries.has(entry.key)) throw new Error(`${label}.key 重复: ${entry.key}`);
    entries.set(entry.key, entry.count);
  }
  return entries;
}

/** 基线按 UTF-16 码元字典序升序写入：diff 只反映增删，不反映采集顺序或运行机器的 locale。 */
export function serializeBaseline(entries) {
  const sorted = [...entries.entries()].sort((a, b) => compareCodePoints(a[0], b[0]));
  return `${JSON.stringify(
    { version: 1, entries: sorted.map(([key, count]) => ({ key, count })) },
    null,
    2,
  )}\n`;
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

/** lint 的 regression 分组顺序：error 在前、warning 在后；其它 gate 没有严重级别。 */
function severityRank(gate, key) {
  if (gate !== "lint") return 0;
  const [severity = ""] = decodeKey(key).fields;
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

export function formatReport({ gate, total, baselineTotal, regressions, improvements }) {
  const sort = (items) =>
    [...items].sort(
      (a, b) =>
        severityRank(gate, a.key) - severityRank(gate, b.key) || compareCodePoints(a.key, b.key),
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
