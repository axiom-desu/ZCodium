import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 治理边界回归：只解析源码 AST，不执行源码、不读取用户数据、不编译 Rust、不打包。
// 首轮 CI（run 39398035529，HEAD eff88e64）报 knip 新增 5 个 unused type（1146 vs 1141）；
// 全仓 git grep 确认这些类型没有跨文件消费，因此收为文件内私有，而不是改基线或忽略。
const CONFIG_FACTORY = "apps/zcode-cli/packages/adapters/src/config/config-factory.ts";
const MARKETPLACE = "apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts";
const TURN_STATE = "apps/zcode-cli/packages/core/src/agent/turn-state.ts";
const RUNTIME_TYPES = "apps/zcode-cli/packages/core/src/runtime/types.ts";
const PERMISSION_SERVICE = "apps/zcode-cli/packages/core/src/permission/service.ts";
const CORE_INDEX = "apps/zcode-cli/packages/core/src/index.ts";

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
    for (const element of statement.exportClause.elements) {
      names.add(element.name.text);
    }
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

test("knip governance: five adapter types stay file-private with no cross-file consumers", async () => {
  const configFactory = await parseFile(CONFIG_FACTORY);
  for (const name of ["McpServerConfigSource", "PluginConfigScope", "PluginConfigSources"]) {
    assertFilePrivateType(configFactory, name);
  }

  const marketplace = await parseFile(MARKETPLACE);
  for (const name of ["MarketplaceRefreshFailure", "PluginValidationDiagnostic"]) {
    assertFilePrivateType(marketplace, name);
  }
});

test("P0-A governance: removed runtime types keep a single authoritative declaration", async () => {
  const turnState = await parseFile(TURN_STATE);
  const turnStateTypes = typeDeclarations(turnState);
  for (const name of ["PermissionDecisionResult", "ToolScheduleItem"]) {
    assert.equal(
      turnStateTypes.has(name),
      false,
      `${name} 不得在 turn-state.ts 本地重新声明（P0-A 已收敛到权威定义）`,
    );
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

  const coreIndex = await parseFile(CORE_INDEX);
  assert.equal(
    exportDeclarationNames(coreIndex).has("PermissionDecisionResult"),
    true,
    "core 公开入口仍需从 permission 模块导出 PermissionDecisionResult",
  );
});
