# Coding Plan 用 API Key 查看剩余额度

## 背景与产品规则

账号登录体系已从本仓库移除（见 `packages/services` 无 `oauth/` 目录、`model-execution.ts` 对
`zhipu-account` 直接拒绝）。Coding Plan 用户仍需要一个明确的入口：

- **取用方式只有一种：自己填 API Key。** 不使用 OAuth、不依赖 `zcode.z.ai`、不引入
  `zhipu-account` 运行时。模板 `bigmodel-api` / `zai-api`（`access.type = zhipu-coding-plan-api-key`）
  已随包发布并可用。
- **剩余额度直接拿用户自己那把 Key 查。** 官方 monitor 接口只认 API Key，不需要业务 token、
  不需要 JWT，因此不构成新的官方服务依赖。
- **不允许出现“看着能连账号、实际连不上”的界面。** 这类误导必须被显式文案取代。

## 所有者与接口

### 数据所有权

额度是**远端事实**，不作持久化，不作本地缓存层：每次打开使用统计页按需拉取，失败不写盘、
不覆盖上一次成功快照以外的东西。UI 只持有一次请求的结果，不复用为全局状态。

```text
用户 API Key (Provider Config，唯一持久化源)
        │
        ▼
UsageStatsSection (UI 每次刷新发起命令)
        │  IUsageStatsService.getCodingPlanQuota({providerId, baseUrl, apiKey, family})
        ▼
services/coding-plan-quota（唯一请求发起者，经宿主 ApiClient 出口）
        │  GET <family origin>/api/monitor/usage/quota/limit
        ▼
CodingPlanQuotaSnapshot（纯展示数据，不落盘）
```

### 端点

| family     | origin 解析                                                 | 路径                             |
| ---------- | ----------------------------------------------------------- | -------------------------------- |
| `bigmodel` | `resolveBigModelApiOrigin(env)`，缺省 `https://bigmodel.cn` | `/api/monitor/usage/quota/limit` |
| `zai`      | `resolveZaiBusinessBaseUrl(env)`，缺省 `https://api.z.ai`   | `/api/monitor/usage/quota/limit` |

鉴权头沿用上游口径：`authorization: <apiKey>`，**不加 `Bearer` 前缀**。不发送 org/project 头
（Team Plan 不在本次范围内）。

### family 判定

不新增字段。按 provider 的 `config.api.baseUrl` 主机名判定，复用既有工具
`resolveModelProviderFamilyIdByBaseURL`；判定不出 family 的 provider 不提供额度入口。

### 接口

`packages/shared/src/usage-quota.ts` 新增：

- `CodingPlanQuotaRequest`：`{ providerId, baseUrl, apiKey, timeZone? }`
- `CodingPlanQuotaSnapshot`：`{ fetchedAt, family, level, limits: UsageQuotaLimit[], remaining }`

`IUsageStatsService` 新增一个方法 `getCodingPlanQuota(request)`。其余既有方法不变。

## 失败语义

| 情况                                                  | 行为                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| provider 没有 `zhipu-coding-plan-api-key` 或 Key 为空 | 不发请求，UI 展示“先填 API Key”引导                            |
| 请求失败 / 非 2xx / JSON 非法                         | 返回 `error`，UI 展示失败提示 + 重试；**不缓存、不伪造空额度** |
| 响应 `success=false` 或业务码非 0/200                 | 视为失败，不带出 limits                                        |
| 响应缺 `data`                                         | 视为“无可用额度信息”，展示空态而不是 0%                        |

不允许把“查询失败”渲染成“额度用完”，也不允许把“无额度数据”渲染成“没有套餐”。

## 误解消除（同批改动）

1. `zhipu-account` 记录若出现在设置页详情，只渲染只读说明「该连接方式已移除，请改用 API Key」，
   不再呈现任何可编辑控件。
2. Coding Plan 模板的 API Key 区文案明确说明“这是 Coding Plan 的 API Key，去哪里获取”，
   不再使用“连接账号”“登录”一类措辞。

## 非目标

- 不恢复 OAuth / `WelcomeScreen` / deep link 回调 / `zhipu-account` 运行时。
- 不做 Team Plan（`type=2` + org/project 头）。
- 不做额度重置（`/api/v1/coding-plan/reset`）、订阅权益（`/api/biz/subscription/list`）、
  套餐购买。这些在上游都依赖账号 token，不在本 spec 内。
- 不引入新的缓存、去重或轮询。

## 验收

1. 配置 `bigmodel-api` 模板并填入有效 Key 后，使用统计页出现剩余额度条；刷新可重新拉取。
2. 未填 Key 时不发网络请求，显示“先填 API Key”，不显示 0% 或“额度用完”。
3. 断网 / 401 / 返回非 JSON 时显示失败提示与重试，不把它渲染成额度耗尽。
4. 用 `zai-api` 模板时请求 `api.z.ai`，不请求 bigmodel 域。
5. 全仓仍不存在 `oauth` 服务通道、`zhipu-account` 的可编辑表单路径。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
