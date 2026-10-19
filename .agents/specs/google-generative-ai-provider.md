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

### 模型目录与元数据

原生目录端点是 `GET {baseURL}/models`，响应为
`{ models: [{ name: "models/xxx", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods }] }`，
模型 id 带 `models/` 前缀。读取时必须剥掉该前缀，否则模型 id 会与用户手填的不一致。

`ProviderModelCatalogSuccess.metadata` 按 `modelId` 携带**端点显式返回**的元数据，
供「获取模型」预填草稿：

| 端点字段                     | 落到配置                          |
| ---------------------------- | --------------------------------- |
| `inputTokenLimit`            | `properties.contextWindow`        |
| `outputTokenLimit`           | `optionSpecs.maxOutputTokens.max` |
| `displayName`                | 仅选择器展示，**不覆盖模型 ID**   |
| `supportedGenerationMethods` | 仅记录，当前不映射为能力开关      |

### contextWindow 语义（已核实）

`contextWindow` 是**输入与输出共享**的窗口，不是纯输入上限。`core/src/compact/policy.ts`
的 `getEffectiveContextWindowSize()` 会自己扣掉输出预留：

```text
effectiveContextWindow = contextWindow - min(maxOutputTokens ?? 32K, 21K)
```

因此 `inputTokenLimit → contextWindow`、`outputTokenLimit → optionSpecs.maxOutputTokens.max`
这条映射是**正确且必要的一对**：只填前者会让压缩阈值按 32K 默认预留计算，
只填后者则压缩时会按 200K 兜底窗口估算。

### 模型能力来源（重要）

**端点不提供能力元数据。** 实测 opencode Go/Zen：

```
404  /inference/google/v1beta/models          ← 原生 models.list 不存在
404  /inference/go/google/v1beta/models
404  /inference/google/v1beta/models/{id}     ← 单模型 GET 也不存在
200  /zen/v1/models（OpenAI 兼容）            ← 只返回 {id, object, created, owned_by}
```

因此「获取模型」对这类端点必然失败（UI 已改为可点击 + 预防性提示），
而 `contextWindow` / `maxOutputTokens` / 多模态能力**无法在运行时获得**。

解决方式：把值作为**显式配置**写进 `modelApiRules`（`apiTypeMatch: "google-generative-ai"`），
数据取自 OpenRouter `/api/v1/models` 的 `google/*` 条目
（`context_length`、`top_provider.max_completion_tokens`、`architecture.input_modalities`）。

这是"查到的常量"而不是"按模型名推断"，与前面的硬约束不冲突。

规则顺序敏感：`gemini-3.5-flash-lite` 必须排在 `gemini-3.5-flash` 之前，
`gemini-4-argon-contributor` 必须排在 `gemini-4-argon` 之前，否则长名会被短名规则先命中。

### ⚠️ 临时补丁：作用域限定到 OpenCode，需要后续清理

上述 Gemini 元数据规则**是给 OpenCode 擦屁股的临时补丁**，因此写在 `providerSiteRules`
并用 `baseUrlMatch` 限定：

```json
"baseUrlMatch": "https://opencode\\.ai/inference/(?:go/)?google/v1beta/?"
```

**不能**写成全局 `modelApiRules`：那样会污染所有接 Gemini 的端点，
用错误的 OpenCode 上限去覆盖用户自建代理或 Google 官方直连的真实能力。

当前覆盖范围（实测）：

| 端点                                          | 结果                           |
| --------------------------------------------- | ------------------------------ |
| `opencode.ai/inference/google/v1beta` (Zen)   | ✅ ctx 1048576 / maxOut 65536  |
| `opencode.ai/inference/go/google/v1beta` (Go) | ✅ ctx 1048576 / maxOut 943718 |
| `generativelanguage.googleapis.com/v1beta`    | ❌ 落到兜底 200K / 32K         |
| 用户自建代理                                  | ❌ 落到兜底                    |

#### 实测数据（Google 官方 key 验证）

官方 `models.list` **确实返回完整元数据**，此前基于 OpenCode 得出的"拿不到能力"结论只适用于 OpenCode：

```
GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000
```

响应含 `inputTokenLimit`、`outputTokenLimit`、`displayName`、
`supportedGenerationMethods`、`temperature`、`topP`、`topK`、`thinking`。
`collectCatalog` / `readCatalogMetadata` 对这些字段的解析已用真实响应验证通过，
`models/` 前缀也能正确剥离。

两个由此暴露的问题：

1. **不要在能力字段上信任 OpenRouter。** OpenRouter 报 `gemini-4-argon` 的
   `max_completion_tokens` 为 `943718`，而该值恰好等于 `1048576 × 0.9`，是推算值；
   Google 官方 `outputTokenLimit` 为 `32768`，相差 30 倍。多模态字段
   （`architecture.input_modalities`）官方不返回，仍只能仰赖 OpenRouter，
   但**数值上限一律以官方为准**。
2. **必须显式请求满页。** 官方 `models.list` 默认只回 50 条并给 `nextPageToken`，
   不指定 `pageSize` 会静默丢模型（实测 63 个只拿到 50 个）。已固定请求
   `?pageSize=1000`。

**TODO（条件触发即可删除）**：当 OpenCode 的 Gemini 端点开始返回能力元数据
（`models.list` 可用，或 OpenAI 兼容目录带上 `context_length`），
应删除这批 `providerSiteRules`，改由 `ProviderModelCatalogSuccess.metadata` 自动填充，
否则两边会出现两个事实源。

同时遗留一项未做：Google 官方直连同样拿不到元数据（其 `models.list` 需要单独的
fixture 验证），目前只能落兜底 200K；这属于独立议题，不与本补丁合并。

### Gemini 的 option map 必须嵌进 generationConfig

Gemini 的生成参数只有一个入口 `generationConfig`。写成顶层键（OpenAI 风格）会被网关
**静默忽略**——没有报错，只是请求里没有该字段，表现为"设了 maxOutputTokens 却不生效"。

因此 `modelApiRules` 必须提供一条 `apiTypeMatch: "google-generative-ai"` 的规则：

```json
"maxOutputTokens": { "map": "{'generationConfig': {'maxOutputTokens': maxOutputTokens}}" }
```

`reasoningLevel` 走 `generationConfig.thinkingConfig`，**但两个档位的写法不对称**（实测结论）：

| 档位       | 发送内容                                         | 原因                       |
| ---------- | ------------------------------------------------ | -------------------------- |
| `enabled`  | `{thinkingLevel: "high", includeThoughts: true}` | `high` 对 8 个模型全部接受 |
| `disabled` | **省略 `thinkingConfig`**（map 返回 `{}`）       | 见下                       |

`disabled` 不能照直觉写 `{thinkingBudget: 0}` 或 `{thinkingLevel: "minimal"}`：

- `thinkingBudget: 0` → `gemini-4-argon` 返回 400 `Thinking budget is not supported for this model`
- `thinkingLevel: "minimal"` → `gemini-4-argon` / `3.1-pro` / `3.8-flash` / `3.7-flash` 返回 400
- 省略字段 → 全部 200

代价是部分模型（`3.1-pro`、`3.8-flash`、`3.6-flash`）在"关闭"档位下仍会思考，
`thoughtsTokenCount > 0`。这是端点行为，不是本地可修正的；因此**不要**在 UI 上承诺
"关闭思考"，只承诺"不做显式请求"。

实测矩阵（8 模型 × 2 档位 = 16 组）全部 200。

硬约束：**不从模型名或产品系列推断能力**。端点没给的字段整条缺席
（`metadata[modelId] === undefined`），调用方必须退回既有规则匹配，不能当作
"零能力"或补 0。`displayName` 不能被当成模型 ID——身份判定只认剥过前缀的 `name`。

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
| 目录项只有 id、没有上限字段 | 该模型 `metadata` 缺席，草稿不预填上限，回退既有模型规则                                    |
| 端点不实现 `models.list`    | 「获取模型」**不禁用**：点击后先显示预防性提示，再照常请求并按真实结果报错                  |
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
   端点返回 `inputTokenLimit` / `outputTokenLimit` 时，新加模型草稿带对应上下文与输出上限；
   未返回时草稿不带这两个字段（不补 0、不推断）。
   2b. 对 `google-generative-ai` 格式点击「获取模型」时，弹窗**同时**显示预防性提示与真实失败结果；
   提示不能被 `errorMessage` 挤掉（实测请求几毫秒即失败，用 `hint && !error` 会让提示永远不可见）。
3. 鉴权使用 `x-goog-api-key`，不发送 `Authorization: Bearer` 或 `x-api-key`。
4. 其它三种格式的请求报文与鉴权头完全不变（回归）。
5. `providerFamilyDomain` 仍只有 `zai` / `bigmodel` 两个值，`family` 相关逻辑零改动。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过，`node --test scripts/ci/*.test.mjs` 全绿。
