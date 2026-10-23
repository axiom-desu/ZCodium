import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_TURN_USAGE,
  WORKBENCH_USAGE,
  workbenchModelServer,
} from "../lib/zcode-cli-rust-workbench-model.mjs";

/**
 * 直接验证共享 fixture 的真实 SSE：usage scenario 的三轮必须是 1000/700，
 * 普通 prompt 仍保持默认 1000/7。同时验证普通答复的 `WB_REPLY_<requestIndex>`
 * nonce 随真实请求单调变化（相同 prompt 重发也不同），供 PTY 区分新旧回复。
 * 期望不依赖 smoke 自己回读自己的屏幕。
 */
async function exchange(baseUrl, text) {
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
  let content = "";
  let marker;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    const parsed = JSON.parse(payload);
    if (parsed.usage) usages.push(parsed.usage);
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") content += delta;
  }
  marker = /WB_REPLY_(\d+)/.exec(content);
  assert.equal(usages.length, 1, `${text}: expected exactly one usage event, got ${usages.length}`);
  return { usage: usages[0], content, marker };
}

test("workbench fixture separates usage-turn tokens from the default profile", async () => {
  const server = await workbenchModelServer();
  try {
    const markers = [];
    for (const text of ["usage turn 1", "usage turn 2", "usage turn 3"]) {
      const reply = await exchange(server.baseUrl, text);
      assert.deepEqual(reply.usage, USAGE_TURN_USAGE, text);
      // usage 轮走普通 echo 分支，仍必须带本轮 nonce 且保留原 answer 正文。
      assert.match(reply.content, new RegExp(`^answer: ${text}\\nWB_REPLY_\\d+$`));
      markers.push(Number(reply.marker?.[1]));
    }
    const plain = await exchange(server.baseUrl, "plain prompt");
    assert.deepEqual(plain.usage, WORKBENCH_USAGE);
    assert.ok(plain.content.startsWith("answer: plain prompt\nWB_REPLY_"));
    markers.push(Number(plain.marker?.[1]));
    // 正则只覆盖三轮：其他编号仍是默认 profile，避免把任意 usage 文本都放宽。
    const usageFour = await exchange(server.baseUrl, "usage turn 4");
    assert.deepEqual(usageFour.usage, WORKBENCH_USAGE);
    markers.push(Number(usageFour.marker?.[1]));
    // 同一 prompt 重复提交必须得到不同 nonce：PTY 才能拒绝旧的 response/Ready。
    const repeat = await exchange(server.baseUrl, "plain prompt");
    assert.deepEqual(repeat.usage, WORKBENCH_USAGE);
    markers.push(Number(repeat.marker?.[1]));
    assert.notEqual(
      repeat.marker?.[1],
      plain.marker?.[1],
      "repeated prompt reused the previous reply nonce",
    );
    assert.deepEqual(
      markers,
      [1, 2, 3, 4, 5, 6],
      `nonce must be the real, TITLE-excluded request index: ${markers}`,
    );
    assert.equal(server.requests.length, 6);
  } finally {
    await server.close();
  }
});
