// M4 real TS oracle: the live `AiSdkModelAdapter` is the expected side; the
// Rust `model_fixture` example must match its normalized stream semantics over
// the same scripted loopback fixture. Node owns the fixture.
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { before, test } from "node:test";
import {
  assertLoopbackEndpoint,
  buildRustExample,
  runRustOracle,
  runTsOracle,
  withModelFixture,
} from "../zcode-cli-rust-m4-model-oracle.mjs";

before(
  async () => {
    await buildRustExample();
  },
  { timeout: 600_000 },
);

const MESSAGES = [{ role: "user", content: "hi" }];

const CHAT_OK =
  'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";
const RESPONSES_OK =
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message"}}\n\n' +
  'data: {"type":"response.output_text.delta","output_index":0,"item_id":"m1","delta":"hello "}\n\n' +
  'data: {"type":"response.output_text.delta","output_index":0,"item_id":"m1","delta":"world"}\n\n' +
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello world"}]}}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello world"}]}],"usage":{}}}\n\n';
const ANTHROPIC_OK =
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n' +
  'data: {"type":"content_block_stop","index":0}\n\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'data: {"type":"message_stop"}\n\n';

const sse = (body) => () => ({ sse: true, body });

/** Merge consecutive same-kind deltas so packet/coalescing differences do not hide parity. */
function mergeEvents(events) {
  const merged = [];
  for (const event of events) {
    const last = merged.at(-1);
    if (last && last.reasoning === event.reasoning) last.text += event.text;
    else merged.push({ reasoning: event.reasoning, text: event.text });
  }
  return merged;
}

function normalize(result) {
  if (!result.ok) return { ok: false };
  const events = mergeEvents(result.events);
  return {
    ok: true,
    text: result.text,
    reasoning: events
      .filter((event) => event.reasoning)
      .map((event) => event.text)
      .join(""),
    reason: result.reason ?? null,
    events,
  };
}

async function differential(script, { api, maxRetries = 0, fixtureTimeoutMs = 20_000 }) {
  const runOne = (runner) =>
    withModelFixture(
      script,
      async ({ origin, requests, stats }) => ({
        result: await runner({ api, baseUrl: origin, messages: MESSAGES, maxRetries }),
        accepted: stats.accepted,
        complete: stats.complete,
        requests: requests.length,
      }),
      { timeoutMs: fixtureTimeoutMs },
    );
  const ts = await runOne(runTsOracle);
  const rust = await runOne(runRustOracle);
  return { ts, rust };
}

/** Both the accept layer and the fully-read layer must equal the expected attempt count. */
function assertAttempts(actual, expected, label) {
  assert.equal(actual.accepted, expected, `${label}: accepted connections`);
  assert.equal(actual.complete, expected, `${label}: complete requests`);
  assert.equal(actual.requests, expected, `${label}: recorded requests`);
}

for (const [name, api, body] of [
  ["OpenAI Chat Completions", "openai-chat-completions", CHAT_OK],
  ["OpenAI Responses", "openai-responses", RESPONSES_OK],
  ["Anthropic Messages", "anthropic-messages", ANTHROPIC_OK],
]) {
  test(
    `M4 TS oracle parity: ${name} streamed text/reason/events`,
    { timeout: 60_000 },
    async () => {
      const { ts, rust } = await differential(sse(body), { api });
      assert.equal(ts.result.ok, true, `TS failed: ${JSON.stringify(ts.result)}`);
      assert.equal(rust.result.ok, true, `Rust failed: ${JSON.stringify(rust.result)}`);
      assert.equal(normalize(rust.result).ok, true);
      assert.deepEqual(normalize(ts.result), normalize(rust.result));
      assert.equal(normalize(ts.result).text, "hello world");
      assertAttempts(ts, 1, "TS");
      assertAttempts(rust, 1, "Rust");
    },
  );
}

test("M4 TS oracle parity: 503 retried then streamed success", { timeout: 60_000 }, async () => {
  const script = (index) =>
    index === 0
      ? {
          status: 503,
          headers: { "Retry-After": "0" },
          body: JSON.stringify({ error: { message: "fixture temporary failure" } }),
        }
      : { sse: true, body: CHAT_OK };
  const { ts, rust } = await differential(script, {
    api: "openai-chat-completions",
    maxRetries: 1,
  });
  assert.deepEqual(normalize(ts.result), normalize(rust.result));
  assert.equal(normalize(ts.result).text, "hello world");
  // 同一 retry 预算（maxAttempts = maxRetries + 1）应产生相同的 request 数。
  assertAttempts(ts, 2, "TS");
  assertAttempts(rust, 2, "Rust");
});

test("M4 TS oracle parity: 400 is not retried by either side", { timeout: 60_000 }, async () => {
  const script = () => ({
    status: 400,
    body: JSON.stringify({ error: { message: "bad request", code: "3001" } }),
  });
  const { ts, rust } = await differential(script, {
    api: "openai-chat-completions",
    maxRetries: 3,
  });
  assert.equal(ts.result.ok, false);
  assert.equal(rust.result.ok, false);
  assertAttempts(ts, 1, "TS");
  assertAttempts(rust, 1, "Rust");
});

test(
  "M4 TS oracle boundary: Responses response.failed classification",
  { timeout: 60_000 },
  async () => {
    const script = sse(
      'data: {"type":"response.failed","response":{"error":{"message":"fixture rejection"}}}\n\n',
    );
    const { ts, rust } = await differential(script, { api: "openai-responses" });
    // TS 流把终止的 provider 失败表示为 finish(rawFinishReason=error)，不抛出也不产生文本。
    assert.equal(ts.result.ok, true);
    assert.equal(ts.result.reason, "error");
    assert.equal(ts.result.text, "");
    // Rust 在协议流内把 response.failed 归为失败。
    assert.equal(rust.result.ok, false);
    assert.equal(rust.result.reason, "unknown");
    assertAttempts(ts, 1, "TS");
    assertAttempts(rust, 1, "Rust");
  },
);

test("M4 oracle refuses non-loopback endpoints", () => {
  assert.throws(() => assertLoopbackEndpoint("http://example.com/v1"), /non-loopback/);
  assert.throws(() => assertLoopbackEndpoint("https://127.0.0.1/v1"), /non-loopback/);
  assert.doesNotThrow(() => assertLoopbackEndpoint("http://127.0.0.1:1234"));
});

test(
  "M4 fixture observes an accepted connection that never completes",
  { timeout: 15_000 },
  async () => {
    let scriptCalls = 0;
    await withModelFixture(
      () => {
        scriptCalls += 1;
        return { status: 200, body: "{}" };
      },
      async ({ origin, requests, stats, waitForAccepted }) => {
        const socket = net.connect(Number(new URL(origin).port), "127.0.0.1");
        socket.on("error", () => {});
        await once(socket, "connect");
        // 只发不完整请求头：fixture 已 accept，但读不到 \r\n\r\n，不能计入 complete。
        socket.write(
          "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n",
        );
        await waitForAccepted(1);
        assert.equal(stats.accepted, 1);
        assert.equal(stats.complete, 0);
        assert.equal(requests.length, 0);
        socket.destroy();
      },
      { timeoutMs: 5_000, label: "M4 partial fixture" },
    );
    assert.equal(scriptCalls, 0);
  },
);

test(
  "M4 fixture surfaces handler errors instead of unhandled rejections",
  { timeout: 15_000 },
  async () => {
    await assert.rejects(
      withModelFixture(
        () => {
          throw new Error("fixture script boom");
        },
        ({ origin }) =>
          runTsOracle({
            api: "openai-chat-completions",
            baseUrl: origin,
            messages: MESSAGES,
          }),
        { timeoutMs: 5_000, label: "M4 handler error fixture" },
      ),
      /fixture script boom/,
    );
  },
);
