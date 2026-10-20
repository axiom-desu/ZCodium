import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  ISSUE_KINDS,
  KEY_SEPARATOR,
  assertFormatResultConsistent,
  collectFormatEntries,
  collectKnipEntries,
  collectLintEntries,
  compareEntries,
  decodeKey,
  encodeKey,
  formatReport,
  parseBaseline,
  parseFormatList,
  parseKnipOutput,
  parseLintOutput,
  resolveToolBin,
  serializeBaseline,
} from "./gate-ratchet.mjs";

const names = (items) => items.map((item) => decodeKey(item.key).fields[2]);

// 指纹不含行列号：代码上下移动时必须保持稳定，否则基线会无谓抖动，
// 门禁就会在「只是挪了几行」的 PR 上误报。
test("knip entries ignore line and column so code movement does not churn the baseline", () => {
  const before = collectKnipEntries([
    { file: "src/a.ts", exports: [{ name: "foo", line: 10, col: 1, pos: 100 }] },
  ]);
  const after = collectKnipEntries([
    { file: "src/a.ts", exports: [{ name: "foo", line: 90, col: 3, pos: 900 }] },
  ]);
  assert.deepEqual([...before.keys()], [...after.keys()]);
});

test("each knip issue kind is tracked separately", () => {
  const entries = collectKnipEntries([
    {
      file: "src/a.ts",
      exports: [{ name: "foo" }],
      types: [{ name: "Foo" }],
      files: [{ name: "src/b.ts" }],
    },
  ]);
  const kinds = [...entries.keys()].map((key) => decodeKey(key).fields[0]).sort();
  assert.deepEqual(kinds, ["exports", "files", "types"]);
});

// 同一文件里 knip 会把重复导出组逐个列出，同名会重复出现；
// 指纹去重后仍能捕获新增成员（A,B -> A,B,C 时 C 是新指纹）。
test("duplicate export groups keep new members detectable", () => {
  const before = collectKnipEntries([
    { file: "src/a.ts", duplicates: [{ name: "A" }, { name: "B" }] },
  ]);
  const after = collectKnipEntries([
    { file: "src/a.ts", duplicates: [{ name: "A" }, { name: "B" }, { name: "C" }] },
  ]);
  assert.equal(before.size, 2);
  assert.equal(after.size, 3);
  const { regressions } = compareEntries(after, before);
  assert.deepEqual(names(regressions), ["C"]);
});

// 同一个符号被多个重复组列两次时仍只算一条：累计次数会让「同一处债务」虚增，
// 迁移后也无法与旧基线的一一对应关系对齐。
test("repeated knip members are collected as a set, not accumulated", () => {
  const entries = collectKnipEntries([
    { file: "src/a.ts", duplicates: [{ name: "A" }, { name: "A" }] },
  ]);
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0], 1);
});

test("compare reports additions and removals independently", () => {
  const baseline = collectKnipEntries([
    { file: "src/a.ts", exports: [{ name: "gone" }] },
    { file: "src/a.ts", exports: [{ name: "kept" }] },
  ]);
  const current = collectKnipEntries([
    { file: "src/a.ts", exports: [{ name: "kept" }] },
    { file: "src/a.ts", exports: [{ name: "fresh" }] },
  ]);
  const { regressions, improvements } = compareEntries(current, baseline);
  assert.deepEqual(names(regressions), ["fresh"]);
  assert.deepEqual(names(improvements), ["gone"]);
});

test("empty issues produce no entries", () => {
  assert.equal(collectKnipEntries([]).size, 0);
  assert.equal(collectKnipEntries(undefined).size, 0);
});

test("issue entries without a file path are skipped instead of becoming phantom keys", () => {
  assert.equal(collectKnipEntries([{ exports: [{ name: "foo" }] }]).size, 0);
  assert.equal(collectKnipEntries([{ file: "", exports: [{ name: "foo" }] }]).size, 0);
});

test("every declared issue kind matches the knip json reporter field names", () => {
  // 漏掉某个分类会让该分类的新增告警被静默放行，因此这里锁死清单。
  assert.deepEqual(
    [...ISSUE_KINDS].sort(),
    [
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
    ].sort(),
  );
});

// 基线只存 key 字串；这里锁死「编解码互逆」，否则基线读回来会报错位。
test("key encoding round-trips through the baseline format", () => {
  const encoded = encodeKey("knip", "exports", "src/a.ts", "someSymbol");
  assert.equal(encoded, "knip\u0000exports\u0000src/a.ts\u0000someSymbol");
  assert.deepEqual(decodeKey(encoded), {
    gate: "knip",
    fields: ["exports", "src/a.ts", "someSymbol"],
  });
});

test("key separator cannot collide with paths or symbol names", () => {
  // 分隔符是基线格式的一部分：换掉它会让所有旧基线一次性失效。
  assert.equal(encodeKey("knip", "exports"), ["knip", "exports"].join(KEY_SEPARATOR));
  // NUL 不可能出现在文件路径或标识符里，所以「第二段=分类、第三段=文件」不会被错位解析。
  const { gate, fields } = decodeKey(encodeKey("knip", "unlisted", "a b/c-d.ts", ""));
  assert.equal(gate, "knip");
  assert.equal(fields[0], "unlisted");
  assert.equal(fields[1], "a b/c-d.ts");
  assert.equal(fields[2], "");
});

test("parseKnipOutput rejects empty or malformed reports instead of reporting zero issues", () => {
  assert.deepEqual(parseKnipOutput('{"issues":[]}'), []);
  assert.throws(() => parseKnipOutput(""), /没有输出 JSON/);
  assert.throws(() => parseKnipOutput("not json"), /不是合法 JSON/);
  assert.throws(() => parseKnipOutput('{"nope":1}'), /缺少 issues/);
});

// 实测 oxlint 在 json reporter 下会先在 stdout 打印一行人类可读文本，必须从首个 { 截取。
test("parseLintOutput tolerates a human readable prefix before the JSON payload", () => {
  const stdout =
    'No files found to lint. Please check your paths and ignore patterns.\n{ "diagnostics": [' +
    '{"severity":"error","code":"eslint(max-lines)","filename":"src/a.ts"},' +
    '{"severity":"warning","code":"eslint(no-unused-vars)","filename":"src/b.ts"}]}';
  const diagnostics = parseLintOutput(stdout);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].code, "eslint(max-lines)");
  assert.equal(diagnostics[1].filename, "src/b.ts");
});

test("parseLintOutput throws on garbage instead of silently reporting zero diagnostics", () => {
  assert.throws(() => parseLintOutput(""), /找不到 JSON 对象/);
  assert.throws(() => parseLintOutput("oxlint exploded"), /找不到 JSON 对象/);
  assert.throws(() => parseLintOutput("{ diagnostics: nope "), /不是合法 JSON/);
  assert.throws(() => parseLintOutput('{"diagnostics":{}}'), /缺少 diagnostics/);
});

test("collectLintEntries counts repeats per severity, code and file without mixing severities", () => {
  const entries = collectLintEntries([
    { severity: "warning", code: "eslint(no-unused-vars)", filename: "src/a.ts" },
    { severity: "warning", code: "eslint(no-unused-vars)", filename: "src/a.ts" },
    { severity: "warning", code: "eslint(no-unused-vars)", filename: "src/a.ts" },
    { severity: "error", code: "eslint(no-unused-vars)", filename: "src/a.ts" },
  ]);
  assert.equal(entries.size, 2);
  assert.equal(entries.get(encodeKey("lint", "warning", "eslint(no-unused-vars)", "src/a.ts")), 3);
  assert.equal(entries.get(encodeKey("lint", "error", "eslint(no-unused-vars)", "src/a.ts")), 1);
});

test("parseFormatList drops empty lines and npx noise but keeps real file paths", () => {
  assert.deepEqual(parseFormatList(""), []);
  assert.deepEqual(parseFormatList("\n\n  \n"), []);
  assert.deepEqual(parseFormatList("npm notice run zcode@3.15.1 npx\nnpm warn something\n"), []);
  assert.deepEqual(parseFormatList("src/a.ts\nsrc/b.ts\nsrc/c.ts\n"), [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
  ]);
});

// exit 1 表示「有差异」，此时解析不到文件说明输出格式变了或被噪声吃掉；
// 若当成干净，格式差异会被静默放行。
test("format exit 1 with an empty file list is a hard error, not a clean result", () => {
  assert.throws(() => assertFormatResultConsistent({ status: 1, files: [] }), /没有解析出任何文件/);
  assert.deepEqual(assertFormatResultConsistent({ status: 1, files: ["src/a.ts"] }), ["src/a.ts"]);
  assert.deepEqual(assertFormatResultConsistent({ status: 0, files: [] }), []);
});

test("format entries are keyed by file with a constant count of one", () => {
  const entries = collectFormatEntries(["src/a.ts", "src/b.ts"]);
  assert.equal(entries.size, 2);
  assert.equal(entries.get(encodeKey("format", "src/a.ts")), 1);
});

test("compareEntries treats rising counts as regressions and falling counts as improvements", () => {
  const current = new Map([
    [encodeKey("lint", "error", "rule", "src/up.ts"), 3],
    [encodeKey("lint", "error", "rule", "src/down.ts"), 1],
    [encodeKey("lint", "error", "rule", "src/new.ts"), 2],
  ]);
  const baseline = new Map([
    [encodeKey("lint", "error", "rule", "src/up.ts"), 1],
    [encodeKey("lint", "error", "rule", "src/down.ts"), 4],
    [encodeKey("lint", "error", "rule", "src/gone.ts"), 2],
  ]);
  const { regressions, improvements } = compareEntries(current, baseline);
  assert.deepEqual(
    regressions.map((item) => [decodeKey(item.key).fields[2], item.delta]),
    [
      ["src/new.ts", 2],
      ["src/up.ts", 2],
    ],
  );
  assert.deepEqual(
    improvements.map((item) => [decodeKey(item.key).fields[2], item.delta]),
    [
      ["src/down.ts", 3],
      ["src/gone.ts", 2],
    ],
  );
});

test("compareEntries ignores unchanged counts", () => {
  const key = encodeKey("format", "src/a.ts");
  const { regressions, improvements } = compareEntries(new Map([[key, 1]]), new Map([[key, 1]]));
  assert.deepEqual(regressions, []);
  assert.deepEqual(improvements, []);
});

test("baseline serialization sorts entries and round-trips counts", () => {
  const entries = new Map([
    [encodeKey("knip", "exports", "b.ts", "x"), 1],
    [encodeKey("lint", "error", "rule", "a.ts"), 3],
  ]);
  const text = serializeBaseline(entries);
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.key),
    [encodeKey("knip", "exports", "b.ts", "x"), encodeKey("lint", "error", "rule", "a.ts")],
  );
  assert.deepEqual(
    [...parseBaseline(text).entries()],
    [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
});

test("baseline parsing rejects corrupt files", () => {
  assert.throws(() => parseBaseline("{oops", ".gate-baseline/knip.json"), /不是合法 JSON/);
  assert.equal(parseBaseline('{"version":1}').size, 0);
});

// knip 的 exports 字段不允许解析 knip/bin/knip.js，直接写死会 ERR_PACKAGE_PATH_NOT_EXPORTED；
// 这里锁死「能定位到真实存在的 CLI 文件」。
test("knip CLI is locatable without going through pnpm exec", () => {
  const bin = resolveToolBin("knip", "knip.js", process.cwd());
  assert.ok(existsSync(bin), `knip CLI 不存在: ${bin}`);
  assert.match(bin, /node_modules[\\/]knip[\\/]bin[\\/]knip\.js$/);
});

test("all three gate CLIs resolve to real bin files", () => {
  for (const [pkgName, binFileName] of [
    ["oxlint", "oxlint"],
    ["oxfmt", "oxfmt"],
    ["knip", "knip.js"],
  ]) {
    const bin = resolveToolBin(pkgName, binFileName, process.cwd());
    assert.ok(existsSync(bin), `${pkgName} CLI 不存在: ${bin}`);
    assert.match(bin, /node_modules[\\/]/);
  }
});

test("report fails only when something regressed", () => {
  const ok = formatReport({
    gate: "knip",
    total: 5,
    baselineTotal: 5,
    regressions: [],
    improvements: [],
  });
  assert.match(ok, /^knip: OK$/m);
  assert.match(ok, /^entries: 5$/m);
  assert.match(ok, /^baseline: 5$/m);
  assert.match(ok, /^regressed: 0$/m);
  assert.match(ok, /^improved: 0$/m);
  assert.doesNotMatch(ok, /已消除/);

  const failed = formatReport({
    gate: "knip",
    total: 6,
    baselineTotal: 5,
    regressions: [
      {
        key: encodeKey("knip", "exports", "src/a.ts", "foo"),
        current: 1,
        baseline: 0,
        delta: 1,
      },
    ],
    improvements: [],
  });
  assert.match(failed, /^knip: FAILED$/m);
  assert.match(failed, /^\+ 1 exports src\/a\.ts :: foo$/m);
});

test("report lists improvements with a tightening hint", () => {
  const report = formatReport({
    gate: "format",
    total: 0,
    baselineTotal: 1,
    regressions: [],
    improvements: [{ key: encodeKey("format", "src/a.ts"), current: 0, baseline: 1, delta: 1 }],
  });
  assert.match(report, /^format: OK$/m);
  assert.match(report, /^- 1 src\/a\.ts$/m);
  assert.match(report, /已消除 1 条，可运行 pnpm gate:baseline 收紧基线。/);
});

// error 必须先于 warning 显示，否则修 warning 的噪声会盖住真正的 error 回归。
test("lint report shows error regressions before warning regressions", () => {
  const report = formatReport({
    gate: "lint",
    total: 3,
    baselineTotal: 1,
    regressions: [
      {
        key: encodeKey("lint", "warning", "eslint(no-unused-vars)", "src/w.ts"),
        current: 1,
        baseline: 0,
        delta: 1,
      },
      {
        key: encodeKey("lint", "error", "eslint(max-lines)", "src/e.ts"),
        current: 1,
        baseline: 0,
        delta: 1,
      },
    ],
    improvements: [],
  });
  const errorLine = report.indexOf("+ 1 error eslint(max-lines) src/e.ts");
  const warningLine = report.indexOf("+ 1 warning eslint(no-unused-vars) src/w.ts");
  assert.ok(errorLine > 0 && warningLine > 0);
  assert.ok(errorLine < warningLine, "error 明细必须排在 warning 之前");
});
