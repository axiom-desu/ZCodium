import assert from "node:assert/strict";
import test from "node:test";
import { createMcpSyncService } from "#src/mcp-sync/mcpSyncService.js";

// 设置页 MCP 审核决定：服务只做转发，且必须显式委托到 agent client；
// 缺少执行面的装配不能伪造成功。

test("setWorkspaceMcpTrust 原样转发摘要与决定", async () => {
  const calls: unknown[] = [];
  const service = createMcpSyncService({
    setWorkspaceMcpTrust: async (params) => {
      calls.push(params);
      return { accepted: true };
    },
  });
  const result = await service.setWorkspaceMcpTrust({
    workspacePath: "/tmp/ws",
    workspaceIdentity: "ws-1",
    serverName: "project-mcp",
    declarationDigest: "a".repeat(64),
    trusted: true,
  });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [
    {
      workspacePath: "/tmp/ws",
      workspaceIdentity: "ws-1",
      serverName: "project-mcp",
      declarationDigest: "a".repeat(64),
      trusted: true,
    },
  ]);
});

test("setWorkspaceMcpTrust 执行面缺失时显式失败", async () => {
  const service = createMcpSyncService();
  await assert.rejects(
    () =>
      service.setWorkspaceMcpTrust({
        workspacePath: "/tmp/ws",
        serverName: "project-mcp",
        declarationDigest: "a".repeat(64),
        trusted: true,
      }),
    /unavailable/u,
  );
});
