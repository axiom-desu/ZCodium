import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// 治理边界回归：只解析源码 AST / 类型绑定，不执行源码、不读取用户数据、不编译 Rust、不打包。
// 首轮 CI（run 39398035529，HEAD eff88e64）报 knip 新增 5 个 unused type（1146 vs 1141）；
// 全仓 git grep 确认这些类型没有跨文件消费，因此收为文件内私有，而不是改基线或忽略。
// 后续按职责拆分后，2 个 marketplace 类型迁到唯一内部类型模块 marketplace-types.ts，
// 并因真实包内跨文件消费而保持 export。守卫因此核对「唯一权威声明 + 真实类型消费 + 公开导出闭包」，
// 而不是硬编码已经迁走的声明位置。
const ADAPTERS = "apps/zcode-cli/packages/adapters";
const SRC = `${ADAPTERS}/src`;
const CONFIG_FACTORY = `${SRC}/config/config-factory.ts`;
const MARKETPLACE = `${SRC}/plugins/marketplace.ts`;
const PLUGINS_INDEX = `${SRC}/plugins/index.ts`;
const ADAPTERS_INDEX = `${SRC}/index.ts`;
const TURN_STATE = "apps/zcode-cli/packages/core/src/agent/turn-state.ts";
const RUNTIME_TYPES = "apps/zcode-cli/packages/core/src/runtime/types.ts";
const PERMISSION_SERVICE = "apps/zcode-cli/packages/core/src/permission/service.ts";
const CORE_INDEX = "apps/zcode-cli/packages/core/src/index.ts";

// 5 个 knip 报出的旧未用导出：无论怎样迁移，都不得重新进入公开 entry 的导出闭包。
const FORMER_PUBLIC_TYPES = [
  "McpServerConfigSource",
  "PluginConfigScope",
  "PluginConfigSources",
  "MarketplaceRefreshFailure",
  "PluginValidationDiagnostic",
];
const CONFIG_PRIVATE_TYPES = FORMER_PUBLIC_TYPES.slice(0, 3);
// 内部类型必须有的真实跨文件类型消费（参数 / 返回类型 / typed array / 属性签名）；
// 仅 import 符号、类型断言、`void x` 占位都不算。shape 取自 HEAD 的字段与可选标记。
const INTERNAL_TYPES = [
  {
    consumers: ["plugins/marketplace-authority.ts"],
    name: "MarketplaceRefreshFailure",
    shape: { optional: [], required: ["code", "failedAt", "message"] },
  },
  {
    consumers: [
      "plugins/marketplace-diagnostics.ts",
      "plugins/marketplace-validation.ts",
      "plugins/marketplace-describe.ts",
      "plugins/marketplace-dependencies.ts",
    ],
    name: "PluginValidationDiagnostic",
    shape: { optional: ["path", "pluginId"], required: ["code", "message", "severity"] },
  },
];

async function parseFile(file) {
  return ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function typeDeclarations(source) {
  const declarations = new Map();
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const entries = declarations.get(node.name.text) ?? [];
      entries.push(node);
      declarations.set(node.name.text, entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

function exportDeclarationNames(source) {
  const names = new Set();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

function assertFilePrivateType(source, name) {
  const declarations = typeDeclarations(source).get(name) ?? [];
  assert.equal(
    declarations.length,
    1,
    `${name} 应仍以恰好一个 interface/type 声明存在（结构保留，只收窄可见性）`,
  );
  assert.equal(isExported(declarations[0]), false, `${name} 不得再带 export 修饰符`);
  assert.equal(
    exportDeclarationNames(source).has(name),
    false,
    `${name} 不得通过 export { ... } / export type { ... } 再次导出`,
  );
}

function importedFrom(source, name) {
  const modules = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (bindings.elements.some((element) => element.name.text === name)) {
      modules.push(statement.moduleSpecifier.text);
    }
  }
  return modules;
}

// ---------------------------------------------------------------------------
// 类型绑定：用 TypeChecker 把 identifier 还原到唯一声明的 symbol，避免同名假名字凑数。
// ---------------------------------------------------------------------------

let adaptersProgramCache;

function loadAdaptersProgram() {
  if (adaptersProgramCache) return adaptersProgramCache;
  const configPath = ts.findConfigFile(path.resolve(ADAPTERS), ts.sys.fileExists, "tsconfig.json");
  assert.ok(configPath, `找不到 ${ADAPTERS}/tsconfig.json`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, "adapters tsconfig.json 必须可读");
  // 只喂包内 tsconfig 的 include（src/**/*），不扫描仓库外或用户目录。
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    { noEmit: true },
    configPath,
  );
  const program = ts.createProgram({ options: parsed.options, rootNames: parsed.fileNames });
  adaptersProgramCache = {
    checker: program.getTypeChecker(),
    program,
    srcRoot: path.resolve(SRC),
  };
  return adaptersProgramCache;
}

// 包内源码（排除 .d.ts 与包内单测：测试源码里的字符串/断言不是消费证据）。
function packageSourceFiles({ program, srcRoot }) {
  const files = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    const relative = path.relative(srcRoot, path.resolve(file.fileName));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join("/");
    if (/\.(test|spec)\.tsx?$/.test(normalized)) continue;
    files.push({ file, relative: normalized });
  }
  return files;
}

function resolveAlias(checker, symbol) {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function isInsideImportOrExport(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportClause(current) ||
      ts.isImportSpecifier(current) ||
      ts.isExportDeclaration(current) ||
      ts.isExportSpecifier(current)
    ) {
      return true;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isFunctionWithBody(node) {
  const functionLike =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
  return functionLike && Boolean(node.body);
}

// 把 identifier 上溯到完整类型节点，再判定该类型位置是否真的标注了某个值/签名。
function classifyTypeUsage(node) {
  let current = node;
  let parent = current.parent;
  while (parent && ts.isTypeNode(parent)) {
    current = parent;
    parent = current.parent;
  }
  if (!parent || parent.type !== current) return undefined;
  if (ts.isParameter(parent)) {
    return { functionNode: parent.parent, kind: "parameter", param: parent };
  }
  if (isFunctionWithBody(parent)) return { functionNode: parent, kind: "return" };
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent))
    return { kind: "property" };
  if (ts.isVariableDeclaration(parent) && parent.initializer) return { kind: "typed-variable" };
  return undefined;
}

// 参数类型只在函数体里真的读取该参数时才算消费（排除 `void x;` 之类的占位）。
function parameterIsConsumed(functionNode, param) {
  if (!functionNode?.body || !ts.isIdentifier(param.name)) return false;
  const name = param.name.text;
  let consumed = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name && !ts.isVoidExpression(node.parent)) {
      consumed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return consumed;
}

function collectTypeUsages(context, declaration, name) {
  const { checker } = context;
  const target = checker.getSymbolAtLocation(declaration.node.name);
  assert.ok(
    target && (target.declarations ?? []).includes(declaration.node),
    `${name} 的 identifier 必须绑定到该唯一声明（防同名假名字）`,
  );
  const usages = [];
  for (const { file, relative } of packageSourceFiles(context)) {
    if (relative === declaration.relative) continue;
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === name && !isInsideImportOrExport(node)) {
        if (resolveAlias(checker, checker.getSymbolAtLocation(node)) === target) {
          const usage = classifyTypeUsage(node);
          if (usage) usages.push({ ...usage, file: relative });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return usages;
}

function moduleExportNames(context, entryFile) {
  const { checker, program } = context;
  const source = program.getSourceFile(path.resolve(entryFile));
  assert.ok(source, `公开入口必须存在：${entryFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, `公开入口必须能解析出 module symbol：${entryFile}`);
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

function assertNoInternalTypeShapeDrift(name, declarationNode, shape) {
  assert.ok(
    ts.isInterfaceDeclaration(declarationNode),
    `${name} 必须保持 interface 声明（不得换成空壳或删类型）`,
  );
  const members = new Map();
  for (const member of declarationNode.members) {
    assert.ok(ts.isPropertySignature(member), `${name} 只应包含属性签名成员`);
    assert.ok(member.name && ts.isIdentifier(member.name), `${name} 成员名必须是简单标识符`);
    assert.ok(member.type, `${name}.${member.name.text} 必须保留显式类型标注`);
    members.set(member.name.text, member);
  }
  assert.deepEqual(
    [...members.keys()].sort(),
    [...shape.required, ...shape.optional].sort(),
    `${name} 的字段集合必须与 HEAD 一致（不得通过删字段/删类型过门禁）`,
  );
  const optional = [...members.values()]
    .filter((member) => member.questionToken !== undefined)
    .map((member) => member.name.text)
    .sort();
  assert.deepEqual(optional, [...shape.optional].sort(), `${name} 的可选标记必须与 HEAD 一致`);
}

test("five former unused types stay nonpublic; internal types only with real consumers", async () => {
  const configFactory = await parseFile(CONFIG_FACTORY);
  for (const name of CONFIG_PRIVATE_TYPES) assertFilePrivateType(configFactory, name);

  const context = loadAdaptersProgram();
  for (const { consumers, name, shape } of INTERNAL_TYPES) {
    const declarations = packageSourceFiles(context).flatMap(({ file, relative }) =>
      (typeDeclarations(file).get(name) ?? []).map((node) => ({ node, relative })),
    );
    assert.equal(
      declarations.length,
      1,
      `${name} 在整个 adapters 包内应恰好有一个权威 interface/type 声明`,
    );
    const [declaration] = declarations;
    assert.equal(
      declaration.relative,
      "plugins/marketplace-types.ts",
      `${name} 的唯一权威声明应留在内部类型模块 marketplace-types.ts（不得回退到 marketplace.ts）`,
    );
    assert.equal(
      isExported(declaration.node),
      true,
      `${name} 因存在真实跨文件类型消费而需要内部 export（但不代表可以外泄到公开入口）`,
    );
    assertNoInternalTypeShapeDrift(name, declaration.node, shape);
    const usages = collectTypeUsages(context, declaration, name);
    const usedFiles = new Set(usages.map((usage) => usage.file));
    for (const consumer of consumers) {
      assert.ok(
        usedFiles.has(consumer),
        `${name} 必须在 ${consumer} 里被真实类型消费（返回类型/typed array/参数），仅 import 符号不算`,
      );
    }
    if (name === "MarketplaceRefreshFailure") {
      const consumed = usages.filter(
        (usage) =>
          usage.kind === "parameter" && parameterIsConsumed(usage.functionNode, usage.param),
      );
      assert.ok(
        consumed.length >= 1,
        "MarketplaceRefreshFailure 必须在参数上被类型化消费，且该参数在函数体内真实使用",
      );
    }
  }

  // 公开导出闭包：用 TypeChecker 展开 export * / barrel 链，而不是只看字面 export 名。
  const publicEntries = [ADAPTERS_INDEX, MARKETPLACE, PLUGINS_INDEX];
  const closures = new Map(
    publicEntries.map((entry) => [entry, moduleExportNames(context, entry)]),
  );
  // 非空证明：闭包确实展开成功且同时包含值导出与类型导出，下面「不存在」的断言才不是假绿。
  const adaptersExports = closures.get(ADAPTERS_INDEX);
  assert.ok(
    [
      "createNodePluginAdapter",
      "describeMarketplacePlugin",
      "DescribeMarketplacePluginResult",
    ].every((name) => adaptersExports.has(name)),
    "adapters 公开入口闭包必须能枚举出已知的值导出与类型导出",
  );
  assert.ok(
    closures.get(MARKETPLACE).has("describeMarketplacePlugin") &&
      closures.get(PLUGINS_INDEX).has("createNodePluginAdapter"),
    "marketplace.ts / plugins/index.ts barrel 闭包必须能枚举出已知导出",
  );
  for (const [entry, names] of closures) {
    for (const name of FORMER_PUBLIC_TYPES) {
      assert.equal(
        names.has(name),
        false,
        `${name} 不得经由 ${entry} 的公开入口暴露（包括未来的 export * 转发）`,
      );
    }
  }
});

test("P0-A governance: removed runtime types keep a single authoritative declaration", async () => {
  const turnState = await parseFile(TURN_STATE);
  const turnStateTypes = typeDeclarations(turnState);
  for (const name of ["PermissionDecisionResult", "ToolScheduleItem"]) {
    assert.equal(turnStateTypes.has(name), false, `${name} 不得在 turn-state.ts 本地重新声明`);
  }
  assert.deepEqual(
    importedFrom(turnState, "ToolScheduleItem"),
    ["../tool/scheduler.js"],
    "turn-state.ts 必须从 scheduler 权威模块导入 ToolScheduleItem",
  );

  const runtimeTypes = await parseFile(RUNTIME_TYPES);
  assert.equal(
    typeDeclarations(runtimeTypes).has("PermissionDecisionResult"),
    false,
    "runtime/types.ts 不得重新声明 PermissionDecisionResult",
  );
  const permissionService = await parseFile(PERMISSION_SERVICE);
  const authoritative = typeDeclarations(permissionService).get("PermissionDecisionResult") ?? [];
  assert.equal(
    authoritative.length,
    1,
    "PermissionDecisionResult 的唯一声明应留在 permission/service.ts",
  );
  assert.equal(isExported(authoritative[0]), true, "permission/service.ts 仍需导出权威类型");
  const permissionMembers = ts.isInterfaceDeclaration(authoritative[0])
    ? authoritative[0].members.length
    : -1;
  assert.equal(permissionMembers, 10, "PermissionDecisionResult 必须保留 HEAD 的 10 个字段");
  const coreIndex = await parseFile(CORE_INDEX);
  assert.equal(
    exportDeclarationNames(coreIndex).has("PermissionDecisionResult"),
    true,
    "core 公开入口仍需导出 PermissionDecisionResult",
  );
});
