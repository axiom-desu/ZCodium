# 原生 Google Gemini（generative-ai）Provider 支持

## 背景与产品规则

本仓库现有三种 Provider API 格式（`anthropic-messages`、`openai-chat-completions`、
`openai-responses`）。Google 的 Gemini 原生 API 在四个维度上都与它们不同，无法沿用：

| 维度             | Gemini 原生                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| 模型位置         | **URL 路径** `/v1beta/models/{model}:generateContent`                         |
| 鉴权头           | `x-goog-api-key`（不是 `Authorization: Bearer`，也不是 `x-api-key`）          |
| 消息结构         | `contents[] + parts[]`；system 走顶层 `systemInstruction`，**无 system role** |
| assistant 角色名 | `"model"`                                                                     |
| 流式             | `:streamGenerateContent?alt=sse`                                              |
| 响应文本         | `candidates[0].content.parts[0].text`                                         |

因此需要新增第四种 API 格式。**产品规则：不引入第二套 provider 抽象，只扩展既有的
`ProviderApiType` 轴。**

明确不做什么：

- 不新增 `ModelProviderFamilyId`。`family` 是**品牌/账号轴**（`oauthProviderId`、
  `startPlanProviderId`、`teamCodingPlanProviderId`、`teamCodingPlanManageUrl`），
  Google 没有 Coding Plan、账号镜像或 Team Plan，塞进去只会让这个只服务官方套餐的枚举长满分支，
  并波及 `normalizeProviderFamilyDomain`、`plan-identity.ts`、`protocol.ts` 的
  `providerFamilyDomain`。
- 不为此新增 `providerGroup`。新 Provider 一律 `standard-personal`。
- 不改任何现有 API 格式的行为。

## 所有者与接口

### 契约（唯一权威）

`packages/provider/src/config/provider-data-schema.ts` 的 `providerApiTypeDataSchema`
是 API 格式枚举的唯一所有者，新增值：`"google-generative-ai"`。

由此派生（全部从该枚举或 `ProviderApiType` 推导，不新开事实源）：

- `packages/provider/src/config/provider-config.ts` — `ProviderApiConfig` 工厂/校验分支
- `packages/services/src/model-provider/providerModelCatalog.ts` — 模型目录读取分支
- `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` — SDK 装配分支
- `packages/ui/src/settings/model-provider-section/ProviderApiFormatSelect.tsx` — 表单选项与路径提示

### 执行层

CLI adapters 依赖 `@ai-sdk/google`（`ai-v6` 线，与仓库现有 `ai@6.0.193` 对齐），
用其 `createGoogleGenerativeAI({ apiKey, baseURL, headers, fetch })` 完成协议映射，
**不自写 messages→contents 转换**。`baseURL` 必须原样使用用户配置值，与其它格式一致
（不回退、不改写成官方网关）。

### 模型目录

原生目录端点是 `GET {baseURL}/models`，响应为 `{ models: [{ name: "models/xxx", ... }] }`，
模型 id 带 `models/` 前缀。读取时必须剥掉该前缀，否则模型 id 会与用户手填的不一致。

## 数据流

```text
Provider Config (api.type = google-generative-ai, baseUrl, access.apiKey)
        │
        ├─ 执行：adapters/model-execution → @ai-sdk/google → x-goog-api-key → /v1beta/models/{model}:generateContent
        ├─ 目录：services/providerModelCatalog → GET {baseUrl}/models → 剥 "models/" 前缀
        └─ 额度：无（本格式不参与 Coding Plan 额度查询）
```

## 失败语义

| 情况                        | 行为                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `api.type` 为未知值         | 沿用现有 `Unsupported Provider API type` 抛错，不静默降级到别的格式                         |
| 目录响应缺 `models` 数组    | 视为空目录（失败），让 fallback 路径有机会；不返回伪造模型                                  |
| 目录项 `name` 非 `models/*` | 仍取其最后一段作为 id，不因前缀缺失而丢弃                                                   |
| 额度查询                    | `resolveCodingPlanQuotaUrl()` 对 Google 主机返回 `null`，额度面板走“未配置 Coding Plan”引导 |

## 迁移边界

- 既有已保存配置的 `api.type` 值不变，无需迁移。
- `legacyModelProviderSerialized.ts` 的 legacy 映射**不**新增 Google 分支：legacy 格式里没有
  这个概念，强行映射会把旧配置读错。未知 legacy 值继续走既有默认。
- 内置模板新增 `gemini`（原生），不动现有 20 个模板。

## 验收

1. 用 `google-generative-ai` 格式创建 Provider 并填入 Gemini API Key 后，可在聊天中选择并完成一次对话。
2. 「获取模型」对该格式请求 `{baseUrl}/models`，返回的列表不含 `models/` 前缀。
3. 鉴权使用 `x-goog-api-key`，不发送 `Authorization: Bearer` 或 `x-api-key`。
4. 其它三种格式的请求报文与鉴权头完全不变（回归）。
5. `providerFamilyDomain` 仍只有 `zai` / `bigmodel` 两个值，`family` 相关逻辑零改动。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过，`node --test scripts/ci/*.test.mjs` 全绿。
