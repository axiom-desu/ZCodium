import assert from "node:assert/strict";
import test from "node:test";
import { workbenchReply } from "./fixtures/mcp-workbench.mjs";

test("workbench MCP fixture answers initialize with the requested protocol version", () => {
  assert.deepEqual(
    workbenchReply({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "workbench", version: "1" },
      },
    },
  );
});

test("workbench MCP fixture exposes one read-only echo tool", () => {
  const reply = workbenchReply({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(reply.result.tools.length, 1);
  assert.equal(reply.result.tools[0].name, "echo");
  assert.equal(reply.result.tools[0].annotations.readOnlyHint, true);
  assert.deepEqual(reply.result.tools[0].inputSchema.required, ["value"]);
});

test("workbench MCP fixture echoes tool arguments with the marker prefix", () => {
  const reply = workbenchReply({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "echo", arguments: { value: "MARKER" } },
  });
  assert.equal(reply.result.content[0].text, 'WORKBENCH_MCP_TOOL_RESULT:echo:{"value":"MARKER"}');
});

test("workbench MCP fixture ignores notifications and rejects unknown methods", () => {
  assert.equal(workbenchReply({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.deepEqual(workbenchReply({ jsonrpc: "2.0", id: 4, method: "tools/unknown" }), {
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32601, message: "Unknown fixture method" },
  });
});
