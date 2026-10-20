import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ISSUE_KINDS,
  KEY_SEPARATOR,
  assertFormatResultConsistent,
  collectFormatEntries,
  collectKnipEntries,
  collectLintEntries,
  compareCodePoints,
  compareEntries,
  decodeKey,
  encodeKey,
  formatReport,
  isMainModule,
  normalizeRepoPath,
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

// 实测 knip 6 的 json reporter 把 duplicates 输出成「组 → 成员」的嵌套数组，不是扁平成员列表。
// 引擎沿用历史基线形状（每个文件一条、name 为空），所以同一文件新增重复成员不会单独计数；
// 这里锁死真实形状校验与该已知不敏感，避免再误以为它能够捕获新增成员。
test("duplicate groups use the real nested shape and collapse to one entry per file", () => {
  const before = collectKnipEntries([
    { file: "src/a.ts", duplicates: [[{ name: "A" }, { name: "B" }]] },
  ]);
  const after = collectKnipEntries([
    { file: "src/a.ts", duplicates: [[{ name: "A" }, { name: "B" }, { name: "C" }]] },
  ]);
  assert.equal(before.size, 1);
  assert.equal(after.size, 1);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  assert.equal(decodeKey([...before.keys()][0]).fields[2], "");
});

// 同一个符号被多个重复组列两次时仍只算一条：累计次数会让「同一处债务」虚增。
test("repeated knip members are collected as a set, not accumulated", () => {
  const entries = collectKnipEntries([
    { file: "src/a.ts", duplicates: [[{ name: "A" }, { name: "A" }]] },
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
  assert.throws(() => collectKnipEntries(undefined), /不是数组/);
});

// 缺 file 或坏条目必须抛错：静默跳过会让 knip 升级后的新告警直接消失。
test("knip issues without a file or with malformed items are rejected, not skipped", () => {
  assert.throws(() => collectKnipEntries([{ exports: [{ name: "foo" }] }]), /为空/);
  assert.throws(() => collectKnipEntries([{ file: "", exports: [{ name: "foo" }] }]), /为空/);
  assert.throws(() => collectKnipEntries([{ file: "src/a.ts", exports: [{ nope: 1 }] }]), /name/);
  assert.throws(
    () => collectKnipEntries([{ file: "src/a.ts", duplicates: [{ name: "A" }] }]),
    /分组不是数组/,
  );
});

// 未知分类必须报错：knip 新增分类时不能静默放行；owners 是 json reporter 的元数据而非分类。
test("unknown knip categories are rejected while reporter metadata is tolerated", () => {
  assert.throws(
    () => collectKnipEntries([{ file: "src/a.ts", brandNewKind: [] }]),
    /未知分类 brandNewKind/,
  );
  const entries = collectKnipEntries([
    { file: "src/a.ts", owners: [{ name: "@team" }], exports: [{ name: "x" }] },
  ]);
  assert.deepEqual([...entries.keys()], [encodeKey("knip", "exports", "src/a.ts", "x")]);
});

test("known knip issue categories retain the reviewed snapshot", () => {
  // 这份清单只是「已审阅的已知分类快照」，不自动跟随 knip 版本变化；
  // 真正的安全网是运行时拒绝未知分类（collectKnipEntries 抛错 → exit 2）。
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
      "nsExports",
      "nsTypes",
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
    '{"severity":"warning","code":"eslint(no-unused-vars)","filename":"src/b.ts"}],' +
    '"number_of_files": 2}';
  const { diagnostics, numberOfFiles } = parseLintOutput(stdout);
  assert.equal(numberOfFiles, 2);
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

// 实测空目录下 oxlint 输出 `number_of_files: 0` + exit 1；当成空 diagnostics 会静默放行。
test("parseLintOutput rejects zero, missing or fractional number_of_files", () => {
  const report = (numberOfFiles) =>
    JSON.stringify({
      diagnostics: [],
      ...(numberOfFiles === undefined ? {} : { number_of_files: numberOfFiles }),
    });
  assert.throws(() => parseLintOutput(report(0)), /number_of_files=0/);
  assert.throws(() => parseLintOutput(report(undefined)), /number_of_files=undefined/);
  assert.throws(() => parseLintOutput(report(1.5)), /number_of_files=1\.5/);
  assert.throws(() => parseLintOutput(report(-1)), /number_of_files=-1/);
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

// 缺字段的历史实现会生成 `lint\0unknown\0\0` 幽灵 key；现在必须直接报错。
test("invalid lint diagnostics are rejected instead of becoming phantom keys", () => {
  assert.throws(() => collectLintEntries([{ message: "x" }]), /severity/);
  assert.throws(
    () => collectLintEntries([{ severity: "hint", code: "rule", filename: "src/a.ts" }]),
    /severity/,
  );
  assert.throws(
    () => collectLintEntries([{ severity: "error", code: "", filename: "src/a.ts" }]),
    /缺少 code/,
  );
  assert.throws(
    () => collectLintEntries([{ severity: "error", code: "rule", filename: "" }]),
    /缺少 filename/,
  );
});

// Windows 工具输出反斜杠；key 必须统一为正斜杠仓库相对路径，且不能折叠大小写。
test("collected paths normalize windows separators and leading ./ without case folding", () => {
  assert.equal(normalizeRepoPath("packages\\win\\A.ts"), "packages/win/A.ts");
  assert.equal(normalizeRepoPath(".\\src\\b.ts"), "src/b.ts");
  assert.equal(normalizeRepoPath("src/./c.ts"), "src/c.ts");
  assert.equal(
    [...collectFormatEntries(["packages\\win\\A.ts"])][0][0],
    encodeKey("format", "packages/win/A.ts"),
  );
});

// 真实 Windows 未在本环境实测：这里只锁死跨平台的数据规范化契约，不模拟 win32 的 path.resolve。
test("path normalization rejects absolute and escaping paths instead of folding them away", () => {
  for (const bad of ["/src/a.ts", "C:\\src\\a.ts", "../a.ts", "src/../../a.ts", "src/", ""]) {
    assert.throws(() => normalizeRepoPath(bad), /仓库根相对路径|未逃逸/, bad);
  }
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
    [encodeKey("knip", "exports", "a.ts", "y"), 1],
  ]);
  const text = serializeBaseline(entries);
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.key),
    [encodeKey("knip", "exports", "a.ts", "y"), encodeKey("knip", "exports", "b.ts", "x")],
  );
  assert.deepEqual(
    [...parseBaseline(text, { gate: "knip" }).entries()],
    [...entries.entries()].sort((a, b) => compareCodePoints(a[0], b[0])),
  );
});

// localeCompare 会随 ICU 默认语言改变顺序（sv_SE 下 ä < z，C 下相反）；写入必须只由码点决定。
test("baseline ordering uses code points rather than localeCompare", () => {
  assert.deepEqual(["z", "ä", "A"].sort(compareCodePoints), ["A", "z", "ä"]);
  const text = serializeBaseline(
    new Map([
      [encodeKey("format", "z.ts"), 1],
      [encodeKey("format", "ä.ts"), 1],
      [encodeKey("format", "A.ts"), 1],
    ]),
  );
  assert.deepEqual(
    JSON.parse(text).entries.map((entry) => entry.key),
    [encodeKey("format", "A.ts"), encodeKey("format", "z.ts"), encodeKey("format", "ä.ts")],
  );
});

test("baseline parsing rejects corrupt structure instead of treating it as empty", () => {
  const parse = (value, gate = "knip") => parseBaseline(value, { gate });
  assert.throws(() => parse("{oops"), /不是合法 JSON/);
  assert.throws(() => parse('{"version":1}'), /entries 必须是数组/);
  assert.throws(() => parse('{"version":2,"entries":[]}'), /version 必须是 1/);
  assert.throws(() => parse('{"entries":[]}'), /version 必须是 1/);
  assert.throws(() => parse('{"version":1,"entries":[],"extra":1}'), /未知字段 extra/);
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: ["knip", "exports", "src/a.ts"].join("\u0000"), count: 1 }],
        }),
      ),
    /段数与 gate 不匹配/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({ version: 1, entries: [{ key: "lint\0error\0rule\0src/a.ts", count: 1 }] }),
      ),
    /段数与 gate 不匹配/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: "knip\0exports\0src/a.ts\0foo", count: 2 }],
        }),
      ),
    /必须为 1/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: "lint\0error\0rule\0src/a.ts", count: 0 }],
        }),
        "lint",
      ),
    /必须是正整数/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [
            { key: "lint\0error\0rule\0src/a.ts", count: 1 },
            { key: "lint\0error\0rule\0src/a.ts", count: 1 },
          ],
        }),
        "lint",
      ),
    /key 重复/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: "lint\0error\0rule\0src\\a.ts", count: 1 }],
        }),
        "lint",
      ),
    /不是规范仓库相对形式/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: "lint\0error\0rule\0../a.ts", count: 1 }],
        }),
        "lint",
      ),
    /仓库相对路径/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          version: 1,
          entries: [{ key: "lint\0error\0rule\0src/a.ts", count: 1, extra: 1 }],
        }),
        "lint",
      ),
    /未知字段 extra/,
  );
});

// 旧基线不要求已排序：读取是 Map，顺序只影响 diff 可读性，不应因顺序拒绝。
test("baseline parsing does not require the old file to be sorted", () => {
  const text = JSON.stringify({
    version: 1,
    entries: [
      { key: "format\0z.ts", count: 1 },
      { key: "format\0ä.ts", count: 1 },
    ],
  });
  assert.deepEqual(
    [...parseBaseline(text, { gate: "format" }).keys()],
    ["format\0z.ts", "format\0ä.ts"],
  );
});

// knip 的 exports 字段不允许解析 knip/bin/knip.js，直接写死会 ERR_PACKAGE_PATH_NOT_EXPORTED；
// 这里锁死「能定位到真实存在的 CLI 文件」。
test("knip CLI is locatable without going through pnpm exec", async () => {
  const bin = await resolveToolBin("knip", "knip.js", process.cwd());
  assert.ok(existsSync(bin), `knip CLI 不存在: ${bin}`);
  assert.match(bin, /node_modules[\\/]knip[\\/]bin[\\/]knip\.js$/);
});

test("all three gate CLIs resolve to real bin files", async () => {
  for (const [pkgName, binFileName] of [
    ["oxlint", "oxlint"],
    ["oxfmt", "oxfmt"],
    ["knip", "knip.js"],
  ]) {
    const bin = await resolveToolBin(pkgName, binFileName, process.cwd());
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

// 入口判定必须是 file URL 比较：含空格路径下 `file://${argv[1]}` 永远不相等，会静默 exit 0。
test("entry guard matches URL-encoded paths with spaces, CJK and percent signs", () => {
  for (const name of ["space probe.mjs", "中文 目录/入口.mjs", "100%/a b.mjs"]) {
    const entry = path.resolve("/tmp/gate entry", name);
    assert.equal(isMainModule(pathToFileURL(entry).href, entry), true, name);
    assert.equal(isMainModule(pathToFileURL(entry).href, `${entry}.other`), false, name);
  }
  assert.equal(isMainModule("file:///tmp/a.mjs", undefined), false);
});

// Windows 的盘符语义由 host 的 path.resolve/pathToFileURL 决定；这里不对 Linux 强加 win32 规则，
// 只锁死「不手写反斜杠转换」。真实 Windows 未在本环境实测。
test("entry guard does not invent win32 path semantics on posix hosts", () => {
  const expected = process.platform === "win32";
  assert.equal(isMainModule("file:///C:/repo/a%20b.mjs", "C:\\repo\\a b.mjs"), expected);
});

// 告警清零是合法终态：当前 0 条 + 基线 0 条必须是 OK + exit 0，不能为「看起来在管」注入条目。
test("a zero-entry format baseline is clean rather than an error", () => {
  const report = formatReport({
    gate: "format",
    total: 0,
    baselineTotal: 0,
    regressions: [],
    improvements: [],
  });
  assert.match(report, /^format: OK$/m);
  assert.match(report, /^entries: 0$/m);
  assert.deepEqual(compareEntries(new Map(), new Map()), { regressions: [], improvements: [] });
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
