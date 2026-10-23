import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createNodeFileSystemAdapter } from "../src/fs/index.js";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";

describe("MCP adapter status is a read-only projection", () => {
  it("a fresh adapter reports no servers without opening a connection", async () => {
    const adapter = createMcpAdapter();
    try {
      assert.deepEqual(await adapter.status(), {});
      assert.deepEqual(await adapter.listTools(), []);
      assert.equal(adapter.toolListRevision(), 0);
    } finally {
      await adapter.close();
    }
  });

  it("a disabled server stays disabled and never starts a process", async () => {
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("disabled-one", {
        type: "stdio",
        command: "/definitely/not/a/real/binary",
        enabled: false,
      });
      assert.equal(status.status, "disabled");
      assert.equal(status.toolCount, 0);
      assert.deepEqual(await adapter.status(), { "disabled-one": status });
      assert.deepEqual(await adapter.listTools(), []);
    } finally {
      await adapter.close();
    }
  });
});

describe("MCP adapter surfaces connection failures instead of a fake green status", () => {
  it("a missing stdio command ends in failed with an error and failureKind", async () => {
    const adapter = createMcpAdapter({ clientName: "test", clientVersion: "0" });
    try {
      const status = await adapter.connectServer("missing-command", {
        type: "stdio",
        command: "/definitely/not/a/real/binary-zcode-test",
        timeoutMs: 5_000,
      });
      assert.notEqual(status.status, "connected");
      assert.equal(status.status, "failed");
      assert.ok(status.error && status.error.length > 0);
      assert.equal(status.failureKind, "process_start_failed");
      const projected = (await adapter.status())["missing-command"];
      assert.equal(projected?.status, "failed");
    } finally {
      await adapter.close();
    }
  });
});

describe("NodeFileSystemAdapter path authorization and atomic writes", () => {
  let root: string;
  const adapter = createNodeFileSystemAdapter();

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-fs-adapter-"));
  });

  after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("rejects relative paths and relative escape attempts", async () => {
    await assert.rejects(adapter.readTextFile({ path: "relative.txt" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "invalid_path");
      return true;
    });
    await assert.rejects(
      adapter.writeTextFile({ path: "../escape.txt", content: "nope" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_path");
        return true;
      },
    );
  });

  it("refuses to write through a symlink", async () => {
    const target = join(root, "real.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "original", "utf8");
    await symlink(target, link);

    await assert.rejects(adapter.writeTextFile({ path: link, content: "changed" }), (error) => {
      assert.match((error as Error).message, /symlink/i);
      return true;
    });
    assert.equal(await readFile(target, "utf8"), "original");
  });

  it("atomic write updates content and returns a matching revision hash", async () => {
    const path = join(root, "nested", "atomic.txt");
    const result = await adapter.writeTextFile({
      path,
      content: "hello\nworld\n",
      createParents: true,
    });
    assert.equal(await readFile(path, "utf8"), "hello\nworld\n");
    assert.equal(result.bytesWritten, 12);
    assert.match(result.revision?.hash ?? "", /^sha256:/);

    const read = await adapter.readTextFile({ path });
    assert.equal(read.content, "hello\nworld\n");
    assert.equal(read.revision?.hash, result.revision?.hash);
  });

  it("glob search stays inside the temp root and does not follow symlinked files", async () => {
    const files = join(root, "search");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "inside.ts"), "inside", "utf8");
    await writeFile(join(files, "inside.txt"), "inside", "utf8");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(files, "linked.txt"));

    const result = await adapter.searchFiles({ path: files, pattern: "**/*.txt" });
    assert.deepEqual(result.files, [join(files, "inside.txt")]);
  });

  it("text search over the temp root reports the temp path", async () => {
    const file = join(root, "grep.txt");
    await writeFile(file, "alpha\nbeta needle\ngamma\n", "utf8");
    const result = await adapter.searchText({
      path: root,
      pattern: "needle",
      outputMode: "content",
    });
    assert.equal(result.mode, "content");
    assert.ok(result.entries.some((entry) => entry.path === file && entry.lineNumber === 2));
  });
});

describe("MCP connection pool keeps one entry per workspace identity", () => {
  const config = {
    type: "stdio" as const,
    command: "fake",
    isolation: "workspace" as const,
  };

  it("shares one connection across leases with the same workspace identity and ref-counts releases", async () => {
    const created: string[] = [];
    const closed: string[] = [];
    const pool = createMcpConnectionPool({
      idleGraceMs: 0,
      createAdapter: ({ connectionContext, serverName }) => {
        created.push(connectionContext.mcpConnectionId);
        const status = {
          status: "connected" as const,
          transport: "stdio" as const,
          toolCount: 0,
          updatedAt: new Date().toISOString(),
        };
        return {
          connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
          connectServer: async () => status,
          disconnectServer: async () => undefined,
          status: async () => ({ [serverName]: status }),
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => {
            closed.push(connectionContext.mcpConnectionId);
          },
        };
      },
    });

    const first = pool.acquireLease({ leaseId: "first" });
    const second = pool.acquireLease({ leaseId: "second" });
    await first.connectServer("shared", config, { workspaceIdentity: "ws-1" });
    await second.connectServer("shared", config, { workspaceIdentity: "ws-1" });
    assert.equal(created.length, 1);
    assert.equal(pool.stats().activeConnections, 1);

    await first.close();
    assert.equal(pool.stats().activeConnections, 1);
    await second.close();
    assert.equal(pool.stats().activeConnections, 0);
    assert.deepEqual(closed, [created[0]]);

    await pool.close();
  });

  it("does not reuse a connection across different workspace identities", async () => {
    const created: string[] = [];
    const pool = createMcpConnectionPool({
      idleGraceMs: 0,
      createAdapter: ({ connectionContext }) => {
        created.push(connectionContext.mcpConnectionId);
        const status = {
          status: "connected" as const,
          transport: "stdio" as const,
          toolCount: 0,
          updatedAt: new Date().toISOString(),
        };
        return {
          connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
          connectServer: async () => status,
          disconnectServer: async () => undefined,
          status: async () => ({}),
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        };
      },
    });

    const lease = pool.acquireLease({ leaseId: "multi" });
    await lease.connectServer("shared", config, { workspaceIdentity: "ws-a" });
    await lease.connectServer("shared", config, { workspaceIdentity: "ws-b" });
    assert.equal(created.length, 2);
    await lease.close();
    await pool.close();
  });
});
