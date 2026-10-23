import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import ts from "typescript";

// 归一化 AST/token 对比：迁移前 handler 体 vs 现在 state 参数化后的普通函数体。
// 目的不是比较行数或 key 数量，而是逐 token 证明 120 个 handler 在搬出 class 时
// 没有漏分支、没有重排、没有偷偷改写常量与事件顺序。
const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../src/zcode-protocol-v4");
const classFile = path.join(sourceDir, "product-projection.ts");
const fixturePath = path.join(testDir, "fixtures/product-projection-handler-tokens.json");

// 迁移时为了不和注入的 `state` 形参冲突而改名的局部变量；语义仍是同一个值。
const LOCAL_ALIASES: Record<string, string> = {
  previewState: "state",
  hookState: "state",
  resultState: "state",
  hookRowBase: "rowBase",
  userRowBase: "rowBase",
};

// 用 AST 叶子遍历取 token：scanner 需要 parser 驱动才能正确继续模板字面量，
// 而 getChildren 展开后的叶子天然包含标点、关键字与模板片段。
function tokenize(node: ts.Node, sf: ts.SourceFile): string[] {
  const tokens: string[] = [];
  const walk = (current: ts.Node): void => {
    const children = current.getChildren(sf);
    if (children.length === 0) {
      const text = current.getText(sf);
      // 空 SyntaxList（例如 `isRunning()` 的空实参）不是 token。
      if (text !== "") tokens.push(text);
      return;
    }
    for (const child of children) walk(child);
  };
  walk(node);
  return tokens;
}

function normalize(rawTokens: string[], stateTakingFns: ReadonlySet<string>): string[] {
  const aliased = rawTokens.map((token) => {
    const alias = LOCAL_ALIASES[token];
    if (alias) return alias;
    return /^[A-Za-z_$][\w$]*Impl$/.test(token) ? token.slice(0, -4) : token;
  });

  // `this.state` → `state`；其余 `this.foo` → `foo`（handler 已变成普通函数）。
  const withoutThis: string[] = [];
  for (let index = 0; index < aliased.length; index += 1) {
    if (aliased[index] === "this" && aliased[index + 1] === ".") {
      if (aliased[index + 2] === "state") withoutThis.push("state");
      else withoutThis.push(aliased[index + 2]);
      index += 2;
      continue;
    }
    withoutThis.push(aliased[index]);
  }

  // 普通函数多出的首参 `state`：仅在“目标是已知 state-taking 函数”时剔除，
  // 这样 `foo(this.state)` 这种真实实参不会被误删。
  const withoutInjectedState: string[] = [];
  for (let index = 0; index < withoutThis.length; index += 1) {
    const token = withoutThis[index];
    const isCallTarget =
      /^[A-Za-z_$][\w$]*$/.test(token) &&
      withoutThis[index + 1] === "(" &&
      withoutThis[index - 1] !== "." &&
      stateTakingFns.has(token);
    if (isCallTarget && withoutThis[index + 2] === "state") {
      if (withoutThis[index + 3] === ",") {
        withoutInjectedState.push(token, "(");
        index += 3;
        continue;
      }
      if (withoutThis[index + 3] === ")") {
        withoutInjectedState.push(token, "(");
        index += 2;
        continue;
      }
    }
    withoutInjectedState.push(token);
  }

  const withoutRedundantArrowParens: string[] = [];
  for (let index = 0; index < withoutInjectedState.length; index += 1) {
    const token = withoutInjectedState[index];
    if (token === "=>" && withoutInjectedState[index + 1] === "(") {
      let depth = 0;
      let close = -1;
      let hasTopLevelComma = false;
      for (let cursor = index + 1; cursor < withoutInjectedState.length; cursor += 1) {
        const inner = withoutInjectedState[cursor];
        if (inner === "(") depth += 1;
        else if (inner === ")") {
          depth -= 1;
          if (depth === 0) {
            close = cursor;
            break;
          }
        } else if (inner === "," && depth === 1) hasTopLevelComma = true;
      }
      const objectLiteral = withoutInjectedState[index + 2] === "{";
      const closesIntoExpression =
        close > 0 && [")", "]", "}", ",", ";"].includes(withoutInjectedState[close + 1] ?? "");
      if (close > 0 && closesIntoExpression && !objectLiteral && !hasTopLevelComma) {
        withoutRedundantArrowParens.push("=>");
        for (let cursor = index + 2; cursor < close; cursor += 1) {
          withoutRedundantArrowParens.push(withoutInjectedState[cursor]);
        }
        index = close;
        continue;
      }
    }
    withoutRedundantArrowParens.push(token);
  }

  const withoutTrailingCommas: string[] = [];
  for (let index = 0; index < withoutRedundantArrowParens.length; index += 1) {
    const token = withoutRedundantArrowParens[index];
    const next = withoutRedundantArrowParens[index + 1];
    if (token === "," && (next === ")" || next === "]" || next === "}")) continue;
    withoutTrailingCommas.push(token);
  }

  // `{ state: state }` 与 `{ state }` 归一到同一个 token 序列。
  const collapsed: string[] = [];
  for (let index = 0; index < withoutTrailingCommas.length; index += 1) {
    const token = withoutTrailingCommas[index];
    if (
      /^[A-Za-z_$][\w$]*$/.test(token) &&
      withoutTrailingCommas[index + 1] === ":" &&
      withoutTrailingCommas[index + 2] === token
    ) {
      collapsed.push(token);
      index += 2;
      continue;
    }
    collapsed.push(token);
  }
  return collapsed;
}

// 只扫描本次迁出的 handler 模块；state/stream/tool-rows 等既存模块里的同名原语
// 不能被当成“注入 state 的 handler”，否则会把真实入参错删。
const PRE_EXISTING_MODULES = new Set([
  "product-projection-state.ts",
  "product-projection-types.ts",
  "product-projection-stream.ts",
  "product-projection-tool-rows.ts",
  "product-projection-hooks.ts",
  "product-projection-model-facts.ts",
  "product-projection-ask-user.ts",
  "product-projection-bash-progress.ts",
]);

function sourceFiles(): string[] {
  return fs
    .readdirSync(sourceDir)
    .filter((entry) => /^product-projection.*\.ts$/.test(entry))
    .filter((entry) => !PRE_EXISTING_MODULES.has(entry))
    .map((entry) => path.join(sourceDir, entry));
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

function collectCurrentHandlers(): {
  bodies: Map<string, { node: ts.Node; sf: ts.SourceFile }>;
  stateTakingFns: Set<string>;
} {
  const bodies = new Map<string, { node: ts.Node; sf: ts.SourceFile }>();
  const stateTakingFns = new Set<string>();
  for (const file of sourceFiles()) {
    const sf = parse(file);
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        const name = statement.name.text;
        bodies.set(name, { node: statement.body, sf });
        if (statement.parameters[0]?.name.getText(sf) === "state") {
          stateTakingFns.add(name);
          stateTakingFns.add(name.replace(/Impl$/, ""));
        }
      }
      if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !member.name || !member.body) continue;
          bodies.set(member.name.getText(sf), { node: member.body, sf });
        }
      }
    }
  }
  return { bodies, stateTakingFns };
}

function findFirstDifference(expected: string[], actual: string[]): string {
  const limit = Math.max(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      return `token #${index}: expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])}`;
    }
  }
  return "no token difference";
}

interface HandlerFixture {
  note: string;
  source: string;
  handlers: Record<string, string>;
  publicMethods: string[];
}

describe("product-projection handler token parity", () => {
  it("keeps every pre-migration handler body token-for-token after state parameterization", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as HandlerFixture;
    const { bodies, stateTakingFns } = collectCurrentHandlers();
    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const [name, encoded] of Object.entries(fixture.handlers)) {
      const expectedTokens = encoded.split("\u0001");
      const entry = bodies.get(`${name}Impl`) ?? bodies.get(name);
      if (!entry) {
        missing.push(name);
        continue;
      }
      const actualTokens = normalize(tokenize(entry.node, entry.sf), stateTakingFns);
      if (JSON.stringify(actualTokens) !== JSON.stringify(expectedTokens)) {
        mismatched.push(`${name}: ${findFirstDifference(expectedTokens, actualTokens)}`);
      }
    }

    assert.deepEqual(missing, [], `迁移后丢失 handler：${missing.join(", ")}`);
    assert.deepEqual(mismatched, [], `handler 分支/顺序发生变化：\n${mismatched.join("\n")}`);
  });

  it("extracted handlers are module-level functions, not class private methods", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as HandlerFixture;
    const sf = parse(classFile);
    const cls = sf.statements.find(ts.isClassDeclaration);
    assert.ok(cls, "product-projection.ts 必须仍导出 ProductProjection class");
    const classMethods = new Set(
      cls.members
        .filter(ts.isMethodDeclaration)
        .map((member) => member.name?.getText(sf))
        .filter((name): name is string => typeof name === "string"),
    );
    const classFields = cls.members.filter(ts.isPropertyDeclaration).map((m) => m.name.getText(sf));

    // class 只剩 25 个 public 薄门面 + atomic clone/adopt；其余 handler 必须是模块函数。
    const publicMethods = new Set(fixture.publicMethods);
    const allowedInClass = new Set([
      ...fixture.publicMethods,
      "cloneProjection",
      "adoptProjection",
    ]);
    const leaked = [...classMethods].filter(
      (name) => fixture.handlers[name] !== undefined && !allowedInClass.has(name),
    );
    assert.deepEqual(leaked, [], `handler 仍在 class 内：${leaked.join(", ")}`);
    const missingPublic = fixture.publicMethods.filter((name) => !classMethods.has(name));
    assert.deepEqual(missingPublic, [], `public method 丢失：${missingPublic.join(", ")}`);
    assert.deepEqual([...publicMethods].sort(), [...fixture.publicMethods].sort());
    assert.deepEqual(classFields, ["state"], "class 只允许一个 ProjectionState 实例字段");
    assert.ok(
      Object.keys(fixture.handlers).length > 120,
      "基线 handler 数量异常，fixture 可能不完整",
    );
  });
});
