import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { contentText } from "./zcode-cli-rust-interop-fixture.mjs";

const TITLE = "Generate a concise title for this coding session.";
/** 模型可见的 MCP 工具名：actor 绑定规则 `mcp__<server>__<tool>`。 */
export const WORKBENCH_MCP_TOOL = "mcp__workbench__echo";
export const WORKBENCH_MCP_ARGUMENT = "WORKBENCH_MCP_ARGUMENT_MARKER";
/**
 * 默认 profile：除 usage 三轮外的每个模型请求都报 prompt=1000, completion=7。
 * usage scenario 的三轮改用 USAGE_TURN_USAGE，让 context 与累计 usage 明确分离。
 */
export const WORKBENCH_USAGE = { prompt_tokens: 1000, completion_tokens: 7 };
/**
 * usage scenario 专用 profile：只有 last user 是 `usage turn 1..3` 时使用。
 * 每轮 prompt=1000 表示滚动上下文，completion=700 是新增输出；
 * queryTaskUsage 对 main_turn 只计 input 相对 source baseline 的增量，
 * 因此三轮累计是 1000 input + 3*700 output = 3100，最后一轮 context 是 1700。
 */
export const USAGE_TURN_USAGE = { prompt_tokens: 1000, completion_tokens: 700 };
const USAGE_TURN = /^usage turn [123]$/;

const TOOL_RESULT_REPLY = "mcp result observed";

/**
 * Loopback Chat Completions model for the workbench acceptance.
 *
 * - `wb-slow …` 先 flush 一个 chunk 再阻塞，直到 `releaseSlow()`（测试用真实请求，
 *   不用 sleep 猜运行态）。
 * - `wb-mcp …` 发起一次真实 MCP 工具调用；工具结果回放后给出固定完成文案。
 * - 其余 prompt 回显 `answer: <text>`，让 PTY 能按请求正文精确等待。
 */
export async function workbenchModelServer() {
  const requests = [];
  const open = new Map();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    // 取消会直接关闭连接；写回失败不是 fixture 错误，不能变成未处理的 error 事件。
    response.on("error", () => {});
    const send = (delta, finish, usage = WORKBENCH_USAGE) => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      if (finish)
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`,
        );
    };
    if (body.includes(TITLE)) return send({ content: '{"title":"Workbench"}' }, "stop");
    requests.push(parsed);
    const messages = parsed.messages.filter(
      (message) =>
        message.role !== "user" ||
        !contentText(message.content).trimStart().startsWith("<system-reminder>"),
    );
    const last = messages.at(-1);
    const text = contentText(last?.content);
    if (last?.role === "tool")
      return send(
        {
          content: contentText(last.content).includes("WORKBENCH_MCP_TOOL_RESULT:")
            ? TOOL_RESULT_REPLY
            : "tool done",
        },
        "stop",
      );
    if (text.includes("wb-mcp"))
      return send(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${randomUUID().slice(0, 8)}`,
              type: "function",
              function: {
                name: WORKBENCH_MCP_TOOL,
                arguments: JSON.stringify({ value: WORKBENCH_MCP_ARGUMENT }),
              },
            },
          ],
        },
        "tool_calls",
      );
    if (text.includes("wb-slow")) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial " } }] })}\n\n`,
      );
      const finish = Promise.withResolvers();
      open.set(text, finish.resolve);
      await finish.promise;
      open.delete(text);
      if (response.destroyed || response.writableEnded) return;
      return send({ content: "slow done" }, "stop");
    }
    const usage = USAGE_TURN.test(text.trim()) ? USAGE_TURN_USAGE : WORKBENCH_USAGE;
    send({ content: `answer: ${text}` }, "stop", usage);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    /** 结束指定 slow 请求的流；必须由真实请求触发，未收到时明确失败。 */
    releaseSlow(text) {
      const release = open.get(text);
      if (!release) throw new Error(`model has no open slow request: ${text}`);
      release();
    },
    isSlowOpen(text) {
      return open.has(text);
    },
    close() {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}
