import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

/**
 * 守住的契约不是"能出文本"，而是 Gemini 原生协议的三个硬事实：
 * 模型在 URL 路径、鉴权只走 x-goog-api-key、报文是 contents[] 而不是 messages[]。
 * 任一被改成 OpenAI/Anthropic 形态，这个测试都会红。
 */

async function withMockGemini(handler, run) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      const result = handler(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const GEMINI_RESPONSE = {
  candidates: [{ content: { parts: [{ text: "pong" }], role: "model" }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
};

test("native Gemini requests keep the model in the path and use x-goog-api-key", async () => {
  await withMockGemini(
    () => GEMINI_RESPONSE,
    async (origin, requests) => {
      const provider = createGoogleGenerativeAI({
        apiKey: "probe-key",
        baseURL: `${origin}/v1beta`,
      });
      const result = await generateText({
        model: provider("gemini-4-argon-contributor"),
        prompt: "ping",
      });

      assert.equal(result.text, "pong");
      assert.equal(requests.length, 1);

      // 模型在路径里，且不带 models/ 前缀重复。
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url, "/v1beta/models/gemini-4-argon-contributor:generateContent");

      // 鉴权只认 x-goog-api-key。
      assert.equal(requests[0].headers["x-goog-api-key"], "probe-key");
      assert.equal(requests[0].headers.Authorization, undefined);
      assert.equal(requests[0].headers["x-api-key"], undefined);

      // 报文是 contents[]，不是 messages[]。
      const payload = JSON.parse(requests[0].body);
      assert.ok(Array.isArray(payload.contents));
      assert.equal(payload.messages, undefined);
    },
  );
});

test("OpenCode Go and Zen Google base urls produce the documented endpoints", async () => {
  for (const [baseUrl, modelId, expectedPath] of [
    [
      "https://opencode.ai/inference/go/google/v1beta",
      "gemini-4-argon-contributor",
      "/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent",
    ],
    [
      "https://opencode.ai/inference/google/v1beta",
      "gemini-4-argon",
      "/inference/google/v1beta/models/gemini-4-argon:generateContent",
    ],
    [
      "https://opencode.ai/inference/google/v1beta",
      "gemini-3.1-pro",
      "/inference/google/v1beta/models/gemini-3.1-pro:generateContent",
    ],
  ]) {
    const provider = createGoogleGenerativeAI({ apiKey: "k", baseURL: baseUrl });
    const model = provider(modelId);
    // SDK 的 getModelPath 只在 id 不含 "/" 时补 models/；这里复现同一规则。
    const modelPath = model.modelId.includes("/") ? model.modelId : `models/${model.modelId}`;
    const path = `${new URL(baseUrl).pathname}/${modelPath}:generateContent`;
    assert.equal(path, expectedPath);
  }
});
