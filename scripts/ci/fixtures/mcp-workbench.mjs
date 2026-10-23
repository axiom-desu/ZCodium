#!/usr/bin/env node
// Real stdio MCP server for the Rust TUI workbench acceptance: one read-only
// `echo` tool plus an optional lifecycle journal, so the E2E can prove the
// server process started, served tools and exited with the CLI.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const TOOL = "echo";
const RESULT_PREFIX = "WORKBENCH_MCP_TOOL_RESULT:";

/** The JSON-RPC answer of one MCP client message (notifications get none). */
export function workbenchReply(message) {
  if (!("id" in message)) return undefined;
  const response = { jsonrpc: "2.0", id: message.id };
  switch (message.method) {
    case "initialize":
      return {
        ...response,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "workbench", version: "1" },
        },
      };
    case "ping":
      return { ...response, result: {} };
    case "tools/list":
      return {
        ...response,
        result: {
          tools: [
            {
              name: TOOL,
              description: "Echo the given value back to the model",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      };
    case "tools/call":
      return {
        ...response,
        result: {
          content: [
            {
              type: "text",
              text: `${RESULT_PREFIX}${message.params.name}:${JSON.stringify(
                message.params.arguments ?? {},
              )}`,
            },
          ],
        },
      };
    default:
      return { ...response, error: { code: -32601, message: "Unknown fixture method" } };
  }
}

function journal(file, entry) {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // 临时 root 已被清理时不影响 MCP 协议本身。
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = process.env.WORKBENCH_MCP_STATE;
  if (state) writeFileSync(state, `${JSON.stringify({ event: "started", pid: process.pid })}\n`);
  const finish = (event) => {
    journal(state, { event, pid: process.pid });
    process.exit(0);
  };
  process.once("SIGTERM", () => finish("terminated"));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    const result = workbenchReply(message);
    if (message.method === "tools/call") {
      journal(state, { event: "tool", name: message.params.name, args: message.params.arguments });
    }
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  finish("closed");
}
