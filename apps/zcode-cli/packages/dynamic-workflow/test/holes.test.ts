import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HOLE_CODE,
  HOLE_NAME_MAX_CHARS,
  HOLE_SITE_ID_PATTERN,
  checkSiteStability,
  collectHoleDiagnostics,
  collectSites,
  createWorkflowProgram,
  holeSiteId,
  isHoleSiteId,
  lowerWorkflowScript,
  spliceHoleBody,
} from "../src/index.js";

/** 编译一份脚本并收集站点表（不打图、不解释，留白规则只看站点表本身）。 */
function tableOf(script: string) {
  const workflow = createWorkflowProgram(script);
  return { table: collectSites(workflow), workflow };
}

/** 只跑留白的 9012 规则，不掺 typecheck / facade-misuse 的诊断。 */
function holeDiagnostics(script: string) {
  const { table, workflow } = tableOf(script);
  return collectHoleDiagnostics(workflow, table);
}

describe("holeSiteId", () => {
  it("hashes the trimmed name with FNV-1a into hole#<8 hex>", () => {
    // 上游文档里的示例 id 逐字节一致（aac47556 的锚点）。
    assert.equal(holeSiteId("决定分组"), "hole#21b40fca");
    assert.equal(holeSiteId("plan"), "hole#b7cbc712");
    assert.equal(holeSiteId("  abc  "), holeSiteId("abc"));
    // 空串是 FNV 偏移基值，唯一且稳定。
    assert.equal(holeSiteId(""), "hole#811c9dc5");
  });

  it("recognizes the id shape and rejects malformed ids", () => {
    assert.ok(isHoleSiteId(holeSiteId("anything")));
    assert.ok(HOLE_SITE_ID_PATTERN.test("hole#00000000"));
    assert.ok(!isHoleSiteId("hole#ABCDEF01"));
    assert.ok(!isHoleSiteId("hole#123"));
    assert.ok(!isHoleSiteId("ask#1"));
  });
});

describe("hole name uniqueness (9012)", () => {
  it("treats two same-name phase markers as one phase", () => {
    assert.deepEqual(holeDiagnostics(`phase("gate");\nphase("gate");\nreturn 1;`), []);
  });

  it("treats two same-name holes as two gaps", () => {
    const diagnostics = holeDiagnostics(
      `await hole<string>("dup");\nawait hole<string>("dup");\nreturn 1;`,
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, HOLE_CODE);
    assert.match(diagnostics[0]?.message ?? "", /two holes are named "dup"/);
  });

  it("rejects a hole that shares its name with a phase marker", () => {
    const diagnostics = holeDiagnostics(`phase("cross");\nawait hole<string>("cross");\nreturn 1;`);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.message ?? "", /shares its name with a phase/);
  });
});

describe("spliceHoleBody", () => {
  it("inserts after the last argument, keeping a prettier-style trailing comma legal", () => {
    const script = [
      "const x = await hole<string>(",
      '  "名",',
      "  `提示`,",
      ");",
      "return x;",
    ].join("\n");
    const { table } = tableOf(script);
    const id = holeSiteId("名");
    const spliced = spliceHoleBody(script, table, id, "return 1;");
    assert.ok(spliced);
    // 插入点在最后一个实参末尾，不是右括号前：尾随逗号与换行原样留在函数体之后。
    assert.match(spliced.text, /`提示`, async \(\) => \{/);
    assert.match(spliced.text, /\n  return 1;\n\},\n\);/);
    assert.equal(spliced.insertedAtLine, 4);
    assert.equal(spliced.insertedLines, 2);
    // 拼出的文本是有效脚本：留白带上函数体。
    const after = tableOf(spliced.text);
    assert.notEqual(after.table.holes.find((hole) => hole.id === id)?.body, undefined);
  });

  it("indents the body two spaces past an indented call", () => {
    const script = [
      "if (true) {",
      "  const y = await hole<string>(",
      '    "inner",',
      "  );",
      "}",
      "return 1;",
    ].join("\n");
    const { table } = tableOf(script);
    const spliced = spliceHoleBody(script, table, holeSiteId("inner"), "return 2;");
    assert.ok(spliced);
    assert.match(spliced.text, /\n    return 2;\n  \}/);
  });

  it("returns undefined for an unknown id and for an already-filled hole", () => {
    const open = 'const x = await hole<string>("open");\nreturn x;';
    const { table } = tableOf(open);
    assert.equal(spliceHoleBody(open, table, "hole#00000000", "return 1;"), undefined);
    const filled = 'const x = await hole<string>("done", async () => 1);\nreturn x;';
    const filledTable = tableOf(filled).table;
    assert.equal(
      spliceHoleBody(filled, filledTable, holeSiteId("done"), "return 1;"),
      undefined,
    );
  });
});

describe("checkSiteStability", () => {
  const scriptWithSiteAfter = [
    "const x = await hole<string>(",
    '  "shift",',
    "  `p`,",
    ");",
    'const w = agent("worker");',
    "return x;",
  ].join("\n");

  it("accepts a fill when no site follows the insertion point", () => {
    const script = 'const x = await hole<string>(\n  "alone",\n  `p`,\n);\nreturn x;';
    const before = tableOf(script).table;
    const id = holeSiteId("alone");
    const spliced = spliceHoleBody(script, before, id, "return 1;");
    assert.ok(spliced);
    const after = tableOf(spliced.text).table;
    assert.deepEqual(
      checkSiteStability(before, after, id, spliced.insertedAtLine, spliced.insertedLines),
      { ok: true },
    );
  });

  it("accepts a fill that shifts every site after the insertion point", () => {
    const before = tableOf(scriptWithSiteAfter).table;
    const id = holeSiteId("shift");
    const spliced = spliceHoleBody(scriptWithSiteAfter, before, id, "return 1;");
    assert.ok(spliced);
    const after = tableOf(spliced.text).table;
    assert.deepEqual(
      checkSiteStability(before, after, id, spliced.insertedAtLine, spliced.insertedLines),
      { ok: true },
    );
  });

  it("rejects a fill whose line shift does not match", () => {
    const before = tableOf(scriptWithSiteAfter).table;
    const id = holeSiteId("shift");
    const spliced = spliceHoleBody(scriptWithSiteAfter, before, id, "return 1;");
    assert.ok(spliced);
    const after = tableOf(spliced.text).table;
    const stability = checkSiteStability(
      before,
      after,
      id,
      spliced.insertedAtLine,
      spliced.insertedLines + 1,
    );
    assert.equal(stability.ok, false);
    assert.match(stability.ok ? "" : stability.detail, /moved from/);
  });
});

describe("HOLE_CODE 9012", () => {
  const cases: Array<[string, RegExp]> = [
    ['await hole("x");\nreturn 1;', /explicit type argument/],
    ["await hole<string>(name);\nreturn 1;", /must be a compile-time string literal/],
    ['await hole<string>("");\nreturn 1;', /has no name to show/],
    ['hole<string>("x");\nreturn 1;', /must be awaited/],
    [
      'await Promise.all([1].map(async () => await hole<string>("x")));\nreturn 1;',
      /fan-out callback/,
    ],
    [
      'await hole<string>("x", fn);\nfunction fn() {}\nreturn 1;',
      /must be an inline async arrow/,
    ],
  ];

  it("reports each rejected shape with the hole rule", () => {
    for (const [script, pattern] of cases) {
      const diagnostics = holeDiagnostics(script);
      assert.ok(
        diagnostics.some((d) => d.code === HOLE_CODE && pattern.test(d.message)),
        `${JSON.stringify(script)} produced ${JSON.stringify(diagnostics)}`,
      );
    }
  });

  it("rejects a body that reads a binding declared after the hole", () => {
    const diagnostics = holeDiagnostics(
      'const x = await hole<string>("late", async () => later);\nconst later = 1;\nreturn x;',
    );
    assert.ok(diagnostics.some((d) => /declared after the hole/.test(d.message)));
  });

  it("allows exactly HOLE_NAME_MAX_CHARS and rejects one character more", () => {
    const allowed = holeDiagnostics(
      `await hole<string>("${"a".repeat(HOLE_NAME_MAX_CHARS)}");\nreturn 1;`,
    );
    assert.deepEqual(allowed, []);
    const rejected = holeDiagnostics(
      `await hole<string>("${"a".repeat(HOLE_NAME_MAX_CHARS + 1)}");\nreturn 1;`,
    );
    assert.ok(rejected.some((d) => d.code === HOLE_CODE && /longer than/.test(d.message)));
  });
});

describe("lowering holes", () => {
  it("lowers an open hole to __host.hole and leaves holeBodies empty", () => {
    const result = lowerWorkflowScript(
      'const x = await hole<string>("open", "need a plan");\nreturn x;',
    );
    assert.ok(result.ok, JSON.stringify(result.diagnostics));
    assert.match(result.lowered?.code ?? "", /__host\.hole\("hole#[0-9a-f]{8}"/);
    assert.deepEqual(result.lowered?.holeBodies, {});
  });

  it("surfaces a filled hole's body text in holeBodies", () => {
    const result = lowerWorkflowScript(
      'const x = await hole<string>("done", "p", async () => "filled");\nreturn x;',
    );
    assert.ok(result.ok, JSON.stringify(result.diagnostics));
    const id = holeSiteId("done");
    assert.ok((result.lowered?.holeBodies[id] ?? "").includes("filled"));
    assert.ok(result.lowered?.siteIds.includes(id));
  });
});
