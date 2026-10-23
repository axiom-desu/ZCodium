import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_TURN_USAGE,
  WORKBENCH_USAGE,
  workbenchModelServer,
} from "../lib/zcode-cli-rust-workbench-model.mjs";

/**
 * 直接验证共享 fixture 的真实 SSE usage：usage scenario 的三轮必须是 1000/700，
 * 普通 prompt 仍保持默认 1000/7。这样 PTY 侧对 3.1K 累计与 1.7K 上下文的期望
 * 有独立证据，不依赖 smoke 自己回读自己的屏幕。
 */
async function usageOf(baseUrl, text) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "model-a",
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const usages = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    const parsed = JSON.parse(payload);
    if (parsed.usage) usages.push(parsed.usage);
  }
  assert.equal(usages.length, 1, `${text}: expected exactly one usage event, got ${usages.length}`);
  return usages[0];
}

test("workbench fixture separates usage-turn tokens from the default profile", async () => {
  const server = await workbenchModelServer();
  try {
    for (const text of ["usage turn 1", "usage turn 2", "usage turn 3"]) {
      assert.deepEqual(await usageOf(server.baseUrl, text), USAGE_TURN_USAGE, text);
    }
    assert.deepEqual(await usageOf(server.baseUrl, "plain prompt"), WORKBENCH_USAGE);
    // 正则只覆盖三轮：其他编号仍是默认 profile，避免把任意 usage 文本都放宽。
    assert.deepEqual(await usageOf(server.baseUrl, "usage turn 4"), WORKBENCH_USAGE);
    assert.equal(server.requests.length, 5);
  } finally {
    await server.close();
  }
});
