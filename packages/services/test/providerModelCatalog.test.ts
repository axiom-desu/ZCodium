import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  buildProviderModelCatalogAttempts,
  createProviderModelCatalogLister,
  fetchProviderModelCatalog,
} from "../src/model-provider/providerModelCatalog.js";

interface RecordedRequest {
  readonly url: string;
  readonly init?: ApiRequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 按完整 URL 路由：/models 与 /v1/models 必须精确区分，否则后缀匹配会抢跑。 */
function createRoutingApiClient(routes: Record<string, () => Response>): {
  apiClient: ApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const apiClient: ApiClient = {
    async request(input, init) {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });
      const handler = routes[url];
      return handler ? handler() : jsonResponse({ error: "not found" }, 404);
    },
  };
  return { apiClient, requests };
}

test("openai compatible attempts use /models first and Bearer auth", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "openai-chat-completions",
    baseUrl: "https://provider.example/v1/",
    apiKey: "key-openai",
  });
  assert.deepEqual(
    attempts.map((attempt) => attempt.url),
    ["https://provider.example/v1/models", "https://provider.example/v1/v1/models"],
  );
  assert.equal(attempts[0]?.headers.Authorization, "Bearer key-openai");
});

test("openai responses shares the openai catalog endpoints", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "openai-responses",
    baseUrl: "https://provider.example",
    apiKey: "key",
  });
  assert.deepEqual(
    attempts.map((attempt) => attempt.url),
    ["https://provider.example/models", "https://provider.example/v1/models"],
  );
});

test("anthropic attempts use /v1/models first with version headers", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "anthropic-messages",
    baseUrl: "https://provider.example",
    apiKey: "key-anthropic",
  });
  assert.deepEqual(
    attempts.map((attempt) => attempt.url),
    ["https://provider.example/v1/models", "https://provider.example/models"],
  );
  assert.equal(attempts[0]?.headers["x-api-key"], "key-anthropic");
  assert.equal(attempts[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(attempts[0]?.headers.Authorization, undefined);
});

test("google attempts use x-goog-api-key and avoid duplicating the version segment", () => {
  const versioned = buildProviderModelCatalogAttempts({
    apiType: "google-generative-ai",
    baseUrl: "https://opencode.ai/inference/google/v1beta/",
    apiKey: "key-google",
  });
  // baseUrl 已带 /v1beta；再拼一次会得到 /v1beta/v1beta/models。
  assert.deepEqual(
    versioned.map((attempt) => attempt.url),
    [
      "https://opencode.ai/inference/google/v1beta/models",
      "https://opencode.ai/inference/google/v1beta/models",
    ],
  );
  assert.equal(versioned[0]?.headers["x-goog-api-key"], "key-google");
  // Gemini 只认 x-goog-api-key；Bearer 与 x-api-key 都应缺席。
  assert.equal(versioned[0]?.headers.Authorization, undefined);
  assert.equal(versioned[0]?.headers["x-api-key"], undefined);

  const bare = buildProviderModelCatalogAttempts({
    apiType: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "key-google",
  });
  assert.deepEqual(
    bare.map((attempt) => attempt.url),
    [
      "https://generativelanguage.googleapis.com/models",
      "https://generativelanguage.googleapis.com/v1beta/models",
    ],
  );
});

test("google catalog strips the models/ prefix from native names", async () => {
  const result = await fetchProviderModelCatalog({
    apiClient: {
      async request() {
        return new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-4-argon" },
              { name: "models/gemini-3.1-pro" },
              { name: "gemini-3-flash" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
    request: { apiType: "google-generative-ai", baseUrl: "https://x.example/v1beta", apiKey: "k" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.modelIds, ["gemini-4-argon", "gemini-3.1-pro", "gemini-3-flash"]);
});

test("google catalog maps only explicitly returned limits into metadata", async () => {
  const result = await fetchProviderModelCatalog({
    apiClient: {
      async request() {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-4-argon",
                displayName: "Gemini 4 Argon",
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
              // 只有 id：元数据必须缺席，不能补零或推断。
              { name: "models/gemini-3-flash" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
    request: { apiType: "google-generative-ai", baseUrl: "https://x.example/v1beta", apiKey: "k" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.modelIds, ["gemini-4-argon", "gemini-3-flash"]);
  assert.deepEqual(result.metadata?.["gemini-4-argon"], {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    displayName: "Gemini 4 Argon",
    supportedGenerationMethods: ["generateContent", "countTokens"],
  });
  // 端点没给字段时整条缺席，调用方据此退回既有规则匹配。
  assert.equal(result.metadata?.["gemini-3-flash"], undefined);
});

test("catalogs without token limits stay metadata-free", async () => {
  const result = await fetchProviderModelCatalog({
    apiClient: {
      async request() {
        return new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
    request: { apiType: "openai-chat-completions", baseUrl: "https://x.example", apiKey: "k" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.modelIds, ["gpt-x"]);
  assert.equal(result.metadata, undefined);
});

test("custom provider headers override built-in auth headers", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "openai-chat-completions",
    baseUrl: "https://provider.example",
    apiKey: "key",
    headers: { Authorization: "Bearer gateway", "X-Tenant": "team" },
  });
  assert.equal(attempts[0]?.headers.Authorization, "Bearer gateway");
  assert.equal(attempts[0]?.headers["X-Tenant"], "team");
});

test("primary success keeps source primary and dedupes ids", async () => {
  const { apiClient, requests } = createRoutingApiClient({
    "https://provider.example/models": () =>
      jsonResponse({
        object: "list",
        data: [{ id: "model-a" }, { id: " model-b " }, { id: "model-a" }, { id: "" }, { nope: 1 }],
      }),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example",
      apiKey: "key",
    },
  });
  assert.deepEqual(result, {
    success: true,
    modelIds: ["model-a", "model-b"],
    source: "primary",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(requests[0]?.init?.timeoutMs, 15_000);
});

test("anthropic payload shape is parsed without id-only assumptions", async () => {
  const { apiClient } = createRoutingApiClient({
    "https://provider.example/v1/models": () =>
      jsonResponse({ data: [{ id: "claude-x", display_name: "Claude X" }] }),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "anthropic-messages",
      baseUrl: "https://provider.example",
      apiKey: "key",
    },
  });
  assert.deepEqual(result, { success: true, modelIds: ["claude-x"], source: "primary" });
});

test("bare array and models key payloads are accepted", async () => {
  const bare = await fetchProviderModelCatalog({
    apiClient: { request: async () => jsonResponse(["m1", { id: "m2" }]) },
    request: { apiType: "openai-chat-completions", baseUrl: "https://a.example", apiKey: "k" },
  });
  assert.deepEqual(bare, { success: true, modelIds: ["m1", "m2"], source: "primary" });

  const modelsKey = await fetchProviderModelCatalog({
    apiClient: { request: async () => jsonResponse({ models: [{ id: "m3" }] }) },
    request: { apiType: "openai-chat-completions", baseUrl: "https://a.example", apiKey: "k" },
  });
  assert.deepEqual(modelsKey, { success: true, modelIds: ["m3"], source: "primary" });
});

test("primary failure falls back to the alternate path and reports fallback", async () => {
  const { apiClient, requests } = createRoutingApiClient({
    "https://provider.example/models": () => jsonResponse({ error: "not found" }, 404),
    "https://provider.example/v1/models": () => jsonResponse({ data: [{ id: "model-fallback" }] }),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example",
      apiKey: "key",
    },
  });
  assert.deepEqual(result, {
    success: true,
    modelIds: ["model-fallback"],
    source: "fallback",
  });
  assert.deepEqual(
    requests.map((request) => request.url),
    ["https://provider.example/models", "https://provider.example/v1/models"],
  );
});

test("network error on primary still reaches the fallback attempt", async () => {
  const { apiClient } = createRoutingApiClient({
    "https://provider.example/models": () => {
      throw new TypeError("fetch failed");
    },
    "https://provider.example/v1/models": () => jsonResponse({ data: [{ id: "model-retry" }] }),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example",
      apiKey: "key",
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.success && result.source, "fallback");
});

test("empty catalog is a failure so the fallback path gets a chance", async () => {
  const { apiClient, requests } = createRoutingApiClient({
    "https://provider.example/models": () => jsonResponse({ data: [] }),
    "https://provider.example/v1/models": () => jsonResponse({ data: [] }),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example",
      apiKey: "key",
    },
  });
  assert.deepEqual(result, {
    success: false,
    error: { code: "empty-catalog", message: "empty catalog" },
  });
  assert.equal(requests.length, 2);
});

test("both attempts failing returns the primary error without leaking the key", async () => {
  const { apiClient } = createRoutingApiClient({
    "https://provider.example/models": () => jsonResponse({ error: "invalid api key" }, 401),
    "https://provider.example/v1/models": () => jsonResponse({ error: "boom" }, 500),
  });
  const result = await fetchProviderModelCatalog({
    apiClient,
    request: {
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example",
      apiKey: "secret-key",
    },
  });
  assert.equal(result.success, false);
  assert.equal(!result.success && result.error.code, "request-failed");
  assert.equal(!result.success && result.error.message, "HTTP 401");
  assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("lister factory forwards timeout overrides", async () => {
  const requests: RecordedRequest[] = [];
  const apiClient: ApiClient = {
    async request(input, init) {
      requests.push({ url: String(input), init });
      return jsonResponse({ data: [{ id: "m" }] });
    },
  };
  const lister = createProviderModelCatalogLister({ apiClient, timeoutMs: 1234 });
  const result = await lister({
    apiType: "anthropic-messages",
    baseUrl: "https://provider.example",
    apiKey: "key",
  });
  assert.equal(result.success, true);
  assert.equal(requests[0]?.init?.timeoutMs, 1234);
});
