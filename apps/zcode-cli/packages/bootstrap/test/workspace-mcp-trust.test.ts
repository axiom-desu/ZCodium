import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { McpPort, McpServerConfig, McpServerStatus } from "@zcode/contracts";
import { createWorkspaceMcpTrust } from "../src/workspace-mcp-trust/index.js";
import { setWorkspaceMcpTrust } from "../src/zcode-protocol/mcp.js";

const PROJECT_SERVER: McpServerConfig = {
  type: "stdio",
  command: "node",
  args: ["server.mjs"],
};

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "zcode-mcp-trust-"));
  const workingDirectory = join(root, "workspace");
  const userConfigPath = join(root, "home", ".zcodium", "cli", "config.json");
  const storageRoot = join(root, "storage");
  await mkdir(join(workingDirectory, ".zcodium"), { recursive: true });
  await mkdir(join(root, "home", ".zcodium", "cli"), { recursive: true });
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { dir: storageRoot } }),
    "utf8",
  );
  await writeFile(
    join(workingDirectory, ".zcodium", "config.json"),
    JSON.stringify({ mcp: { servers: { projectServer: PROJECT_SERVER } } }),
    "utf8",
  );
  const authority = createWorkspaceMcpTrust({
    workingDirectory,
    workspaceIdentity: "workspace-1",
    userConfigPath,
    env: {},
  });
  return {
    authority,
    root,
    storageRoot,
    workingDirectory,
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

function fakePort() {
  const calls = { connect: 0, disconnect: 0 };
  const statuses: Record<string, McpServerStatus> = {};
  const port: McpPort = {
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async (name, config) => {
      calls.connect += 1;
      const status: McpServerStatus = {
        status: "connected",
        transport: config.type,
        toolCount: 1,
        updatedAt: new Date().toISOString(),
      };
      statuses[name] = status;
      return status;
    },
    disconnectServer: async (name) => {
      calls.disconnect += 1;
      return statuses[name];
    },
    status: async () => ({ ...statuses }),
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  return { calls, port };
}

it("inspect returns a stable digest and untrusted project declaration", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const first = await harness.authority.inspect();
  const second = await harness.authority.inspect();
  assert.equal(first.projectServer?.trusted, false);
  assert.equal(first.projectServer?.transport, "stdio");
  assert.match(first.projectServer?.declarationDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(first.projectServer?.declarationDigest, second.projectServer?.declarationDigest);
  // display 只投影命令/环境键，不能写入真实 env 值。
  assert.doesNotMatch(first.projectServer?.display ?? "", /SECRET/u);
});

it("decide persists before returning and exact digest mismatch is rejected", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const review = (await harness.authority.inspect()).projectServer!;
  await assert.rejects(
    harness.authority.decide("projectServer", "0".repeat(64), true),
    /workspace_mcp_declaration_changed/,
  );
  assert.equal(await harness.authority.allows("projectServer", PROJECT_SERVER), false);
  await harness.authority.decide("projectServer", review.declarationDigest, true);
  assert.equal(await harness.authority.allows("projectServer", PROJECT_SERVER), true);
  assert.equal((await harness.authority.inspect()).projectServer?.trusted, true);
  const raw = await readFile(
    join(harness.storageRoot, "security", "workspace-mcp-trust-v1.json"),
    "utf8",
  );
  assert.match(raw, /workspace-mcp-trust|projectServer/u);
  await harness.authority.decide("projectServer", review.declarationDigest, false);
  assert.equal(await harness.authority.allows("projectServer", PROJECT_SERVER), false);
});

it("config change and corrupt store fail closed", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const review = (await harness.authority.inspect()).projectServer!;
  await harness.authority.decide("projectServer", review.declarationDigest, true);
  assert.equal(await harness.authority.allows("projectServer", PROJECT_SERVER), true);
  // 参数变化 = 声明变化：旧授权不能继续放行新命令。
  assert.equal(
    await harness.authority.allows("projectServer", {
      ...PROJECT_SERVER,
      args: ["other.mjs"],
    }),
    false,
  );
  await writeFile(
    join(harness.storageRoot, "security", "workspace-mcp-trust-v1.json"),
    "{corrupt",
    "utf8",
  );
  assert.equal((await harness.authority.inspect()).projectServer?.trusted, false);
  assert.equal(await harness.authority.allows("projectServer", PROJECT_SERVER), false);
  await assert.rejects(
    harness.authority.decide("projectServer", review.declarationDigest, true),
  );
});

it("guard blocks connects until trusted and re-checks on every reconnect", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const { calls, port } = fakePort();
  const guarded = harness.authority.guard(port);
  const blocked = await guarded.connectServer("projectServer", PROJECT_SERVER);
  assert.equal(blocked.status, "untrusted");
  assert.equal(calls.connect, 0);

  const review = (await harness.authority.inspect()).projectServer!;
  await harness.authority.decide("projectServer", review.declarationDigest, true);
  const connected = await guarded.connectServer("projectServer", PROJECT_SERVER);
  assert.equal(connected.status, "connected");
  assert.equal(calls.connect, 1);

  // 撤销后下一次重新连接必须先断开旧连接，不能沿用已准入快照。
  await harness.authority.decide("projectServer", review.declarationDigest, false);
  const revoked = await guarded.connectServer("projectServer", PROJECT_SERVER);
  assert.equal(revoked.status, "untrusted");
  assert.equal(calls.connect, 1);
  // 首次未信任连接已断开一次；撤销后的重连再断开一次，始终不沿用旧连接。
  assert.equal(calls.disconnect, 2);
  assert.equal((await guarded.status()).projectServer?.status, "untrusted");
});

it("discovers fallback .agents/mcp.json alongside project config and fails closed until trusted", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const evil: McpServerConfig = { type: "stdio", command: "node", args: ["evil.mjs"] };
  await mkdir(join(harness.workingDirectory, ".agents"), { recursive: true });
  await writeFile(
    join(harness.workingDirectory, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers: { evil } }),
    "utf8",
  );
  const reviews = await harness.authority.inspect();
  // 项目已有无害声明时，fallback 仍必须进入审核集合，不能“看不见”直接放行。
  assert.ok(reviews.projectServer);
  assert.ok(reviews.evil);
  assert.equal(await harness.authority.allows("evil", evil), false);
  assert.equal(await harness.authority.allows("unknownServer", evil), false);

  const { calls, port } = fakePort();
  const guarded = harness.authority.guard(port);
  const blocked = await guarded.connectServer("evil", evil);
  assert.equal(blocked.status, "untrusted");
  assert.equal(calls.connect, 0);

  await harness.authority.decide("evil", reviews.evil!.declarationDigest, true);
  assert.equal(await harness.authority.allows("evil", evil), true);
});

it("admits explicitly discovered user config but unknown names stay denied", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const userServer: McpServerConfig = { type: "stdio", command: "node", args: ["user.mjs"] };
  await writeFile(
    join(harness.root, "home", ".zcodium", "cli", "config.json"),
    JSON.stringify({
      storage: { dir: harness.storageRoot },
      mcp: { servers: { userServer } },
    }),
    "utf8",
  );
  assert.equal(await harness.authority.allows("userServer", userServer), true);
  assert.equal(await harness.authority.allows("notConfigured", userServer), false);

  const evil: McpServerConfig = { ...userServer, args: ["workspace-evil.mjs"] };
  await mkdir(join(harness.workingDirectory, ".agents"), { recursive: true });
  await writeFile(
    join(harness.workingDirectory, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers: { userServer: evil } }),
    "utf8",
  );
  // 名字属于用户配置，不代表任意同名执行载荷都可信；审核与实际配置必须是同一份。
  assert.equal(await harness.authority.allows("userServer", evil), false);
  const { port, calls } = fakePort();
  const guarded = harness.authority.guard(port);
  assert.equal((await guarded.connectServer("userServer", evil)).status, "untrusted");
  assert.equal(calls.connect, 0);
  assert.equal((await guarded.connectServer("userServer", userServer)).status, "connected");
  assert.equal(calls.connect, 1);
});

it("workspace/mcp/trust only accepts this agent workspace path and key", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const review = (await harness.authority.inspect()).projectServer!;
  const context = {
    deps: { cwd: harness.workingDirectory, env: {} },
  } as unknown as Parameters<typeof setWorkspaceMcpTrust>[0];
  const mismatchedPath = await setWorkspaceMcpTrust(context, {
    workspace: { workspacePath: "/somewhere/else", workspaceKey: "/somewhere/else" },
    serverName: "projectServer",
    declarationDigest: review.declarationDigest,
    trusted: true,
  });
  assert.deepEqual(mismatchedPath, {
    accepted: false,
    reasonCode: "workspace_mcp_trust_unavailable",
  });
  const mismatchedKey = await setWorkspaceMcpTrust(context, {
    workspace: {
      workspacePath: harness.workingDirectory,
      workspaceIdentity: "workspace-1",
      workspaceKey: "not-the-identity",
    },
    serverName: "projectServer",
    declarationDigest: review.declarationDigest,
    trusted: true,
  });
  assert.deepEqual(mismatchedKey, {
    accepted: false,
    reasonCode: "workspace_mcp_trust_unavailable",
  });
});

it("late connect for a replaced configuration cannot overwrite the new target", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const review = (await harness.authority.inspect()).projectServer!;
  await harness.authority.decide("projectServer", review.declarationDigest, true);
  const firstGate = Promise.withResolvers<void>();
  let connects = 0;
  const port: McpPort = {
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async (name, config) => {
      connects += 1;
      if (connects === 1) await firstGate.promise;
      return {
        status: "connected",
        transport: config.type,
        toolCount: connects,
        updatedAt: new Date().toISOString(),
      };
    },
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const guarded = harness.authority.guard(port);
  const first = guarded.connectServer("projectServer", PROJECT_SERVER);
  const second = guarded.connectServer("projectServer", PROJECT_SERVER);
  firstGate.resolve();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(connects, 2);
  // 串行 mutation 队列保证后登记的连接最后落位。
  assert.equal(secondStatus.toolCount, 2);
  assert.equal(firstStatus.toolCount, 1);
});
