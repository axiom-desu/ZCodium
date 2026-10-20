import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  ISSUE_KINDS,
  collectFingerprints,
  compareFingerprints,
  decodeFingerprint,
  encodeFingerprint,
  formatReport,
  resolveKnipBin,
} from "../ci/knip-ratchet.mjs";

// 指纹不含行列号：代码上下移动时必须保持稳定，否则基线会无谓抖动，
// 门禁就会在「只是挪了几行」的 PR 上误报。
test("fingerprints ignore line and column so code movement does not churn the baseline", () => {
  const before = collectFingerprints([
    { file: "src/a.ts", exports: [{ name: "foo", line: 10, col: 1, pos: 100 }] },
  ]);
  const after = collectFingerprints([
    { file: "src/a.ts", exports: [{ name: "foo", line: 90, col: 3, pos: 900 }] },
  ]);
  assert.deepEqual([...before.keys()], [...after.keys()]);
});

test("each issue kind is tracked separately", () => {
  const entries = collectFingerprints([
    {
      file: "src/a.ts",
      exports: [{ name: "foo" }],
      types: [{ name: "Foo" }],
      files: [{ name: "src/b.ts" }],
    },
  ]);
  const kinds = [...entries.values()].map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ["exports", "files", "types"]);
});

// 同一文件里 knip 会把重复导出组逐个列出，同名会重复出现；
// 指纹去重后仍能捕获新增成员（A,B -> A,B,C 时 C 是新指纹）。
test("duplicate export groups keep new members detectable", () => {
  const before = collectFingerprints([
    { file: "src/a.ts", duplicates: [{ name: "A" }, { name: "B" }] },
  ]);
  const after = collectFingerprints([
    { file: "src/a.ts", duplicates: [{ name: "A" }, { name: "B" }, { name: "C" }] },
  ]);
  assert.equal(before.size, 2);
  assert.equal(after.size, 3);
  const { added } = compareFingerprints(after, before);
  assert.deepEqual(
    added.map((entry) => entry.name),
    ["C"],
  );
});

test("compare reports additions and removals independently", () => {
  const baseline = collectFingerprints([
    { file: "src/a.ts", exports: [{ name: "gone" }] },
    { file: "src/a.ts", exports: [{ name: "kept" }] },
  ]);
  const current = collectFingerprints([
    { file: "src/a.ts", exports: [{ name: "kept" }] },
    { file: "src/a.ts", exports: [{ name: "fresh" }] },
  ]);
  const { added, removed } = compareFingerprints(current, baseline);
  assert.deepEqual(
    added.map((entry) => entry.name),
    ["fresh"],
  );
  assert.deepEqual(
    removed.map((entry) => entry.name),
    ["gone"],
  );
});

test("empty issues produce no fingerprints", () => {
  assert.equal(collectFingerprints([]).size, 0);
  assert.equal(collectFingerprints(undefined).size, 0);
});

test("issue entries without a file path are skipped instead of becoming phantom keys", () => {
  assert.equal(collectFingerprints([{ exports: [{ name: "foo" }] }]).size, 0);
  assert.equal(collectFingerprints([{ file: "", exports: [{ name: "foo" }] }]).size, 0);
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

// 基线只存指纹字串；这里锁死「编解码互逆」，否则基线读回来会报错位。
test("fingerprint encoding round-trips through the baseline format", () => {
  const encoded = encodeFingerprint("exports", "src/a.ts", "someSymbol");
  assert.equal(encoded, "exports\u0000src/a.ts\u0000someSymbol");
  assert.deepEqual(decodeFingerprint(encoded), {
    fingerprint: encoded,
    kind: "exports",
    file: "src/a.ts",
    name: "someSymbol",
  });
});

test("fingerprint separator cannot collide with paths or symbol names", () => {
  // NUL 不可能出现在文件路径或标识符里，所以「第一段=分类、第二段=文件」不会被错位解析。
  const entry = decodeFingerprint(encodeFingerprint("unlisted", "a b/c-d.ts", ""));
  assert.equal(entry.kind, "unlisted");
  assert.equal(entry.file, "a b/c-d.ts");
  assert.equal(entry.name, "");
});

// knip 的 exports 字段不允许解析 knip/bin/knip.js，直接写死会 ERR_PACKAGE_PATH_NOT_EXPORTED；
// 这里锁死「能定位到真实存在的 CLI 文件」。
test("knip CLI is locatable without going through pnpm exec", () => {
  const bin = resolveKnipBin(process.cwd());
  assert.ok(existsSync(bin), `knip CLI 不存在: ${bin}`);
  assert.match(bin, /node_modules[\\/]knip[\\/]bin[\\/]knip\.js$/);
});

test("report fails only when something was added", () => {
  const ok = formatReport({ added: [], removed: [], total: 5, baselineTotal: 5 });
  assert.match(ok, /^knip: OK$/m);
  const failed = formatReport({
    added: [{ kind: "exports", file: "src/a.ts", name: "foo" }],
    removed: [],
    total: 6,
    baselineTotal: 5,
  });
  assert.match(failed, /^knip: FAILED$/m);
  assert.match(failed, /\+ exports src\/a\.ts :: foo/);
});
