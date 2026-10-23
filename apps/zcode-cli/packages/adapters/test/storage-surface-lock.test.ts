import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import ts from "typescript";

import * as storage from "../src/storage/index.js";

const EXPECTED_STORAGE_EXPORTS = [
  "FileWorkspaceHookTrustStore",
  "InMemorySessionEventStore",
  "NodeToolArtifactStore",
  "SqliteSessionMigrationError",
  "SqliteSessionStore",
  "createDefaultFileWorkspaceHookTrustStore",
  "createDwfJournalStore",
  "createFileWorkspaceHookTrustStore",
  "createInMemorySessionEventStore",
  "createNodeToolArtifactStore",
  "createSqliteSessionStore",
  "getDefaultSessionDbPath",
  "openStartupSqliteSessionStore",
  "resolveWorkspaceHookTrustStorePath",
] as const;

// 读取 contracts 的 SessionStorePort AST，而不是手抄一份方法表：adapter 可以拆分实现，
// 但 port 上的每个方法都必须继续由 SqliteSessionStore 实例提供。
async function sessionStorePortMethods(): Promise<string[]> {
  const path = new URL(
    "../../contracts/src/interfaces/session-store/store-ports.ts",
    import.meta.url,
  );
  const source = ts.createSourceFile(
    path.pathname,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const methods: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== "SessionStorePort") {
      continue;
    }
    for (const member of statement.members) {
      if (ts.isMethodSignature(member) && member.name) {
        methods.push(member.name.getText(source));
      }
    }
  }
  return methods;
}

it("storage public exports keep the original module surface", () => {
  assert.deepEqual(Object.keys(storage).sort(), [...EXPECTED_STORAGE_EXPORTS].sort());
});

it("SqliteSessionStore still implements every SessionStorePort method", async () => {
  const methods = await sessionStorePortMethods();
  assert.ok(methods.length > 20, "SessionStorePort AST should expose its methods");
  const store = new storage.SqliteSessionStore({ dbPath: ":memory:" });
  try {
    for (const method of methods) {
      assert.equal(
        typeof (store as unknown as Record<string, unknown>)[method],
        "function",
        `missing SessionStorePort method: ${method}`,
      );
    }
  } finally {
    store.close();
  }
});
