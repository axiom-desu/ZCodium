# image-search 后端指向本地

> [!NOTE]
> **本规格仍然有效，只是不再是 backfill 阶段的记录。**
> 上游 3.15.1 同步把其余插件换成了上游版本，但 image-search 未换：上游那版指向官方搜图服务并用 ZCode JWT 鉴权，本仓库仍按本文只连用户自己配置的本地端点，能力现在仍在用。
> 相关决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

`@zcode/image-search-plugin` 是官方内置的搜图 MCP 插件。开源移植时它的 `.mcp.json`
把后端指向 `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search`，即智谱线上服务。

本 spec 记录把默认后端改为本地 loopback 的决策、实现方式与副作用。

## 这个插件是干什么的

它向 Agent 暴露一个 `image_search` MCP 工具：Agent 在写文档、做 PPT、排版网页时需要
插图或参考图时，可以调用它按关键词检索图片，返回可直接引用的图源。它是
HTTP 形态的 MCP server（`type: "http"`），不是本地进程。

配图类技能依赖它：`documents-plugin`（docx）、`pdf-plugin`、`presentations-plugin`（pptx）、
`spreadsheets-plugin`（xlsx）的技能文档都描述了"需要插图时调用搜图工具"的用法。
没有它，这些技能仍然能产出文档，只是拿不到配图。

## 决策

默认指向本地 `http://127.0.0.1:8787`，官方后端改为显式覆盖。

理由：

- 该插件的鉴权是 `zcode_official` / `jwt_token`，凭证由宿主逐请求注入**用户自己的
  JWT**。指向官方后端意味着每次搜图都会把用户的 JWT 发往智谱。
- 默认指向本地可以把"是否把 JWT 发给第三方"变成用户的显式选择，而不是安装即默认。
- 本地后端由用户自己部署，图片来自用户自己的图库或代理，不经过智谱。

## 实现

`userConfig` 是本仓库既有的插件配置机制（schema 见
`packages/shared/src/zcode-protocol/index.ts` 的 `zcodePluginUserConfigOptionSchema`），
`${user_config.<key>}` 在 `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` 的
`resolveTemplate` 中解析，优先级为「用户已配置值 > manifest 默认值」。

改动：

| 文件                                              | 改动                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `image-search-plugin/.zcodium-plugin/plugin.json` | 新增 `userConfig.imageSearchBaseUrl`，默认 `http://127.0.0.1:8787`；版本 0.1.1 → 0.1.2 |
| `image-search-plugin/.mcp.json`                   | URL 由 `${ZCODE_BASE_URL}/...` 改为 `${user_config.imageSearchBaseUrl}/...`            |
| `.env.development`                                | 新增 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS=http://127.0.0.1:8787`                    |
| `.env.example`                                    | 说明该变量的用途、覆盖路径与安全权衡                                                   |

`plugin.json` 里的 `mcpServers` 块与 `.mcp.json` 保持同源；manifest 的 `mcpServers`
可以指向 `.mcp.json` 或内联，此处两者都写了相同内容（沿用官方包的既有形态）。

## 必须同时满足的条件

官方 MCP 鉴权的 origin 信任有两类放行目标
（`packages/shared/src/official-mcp-auth.ts` 的 `isOfficialMcpOriginTrusted`）：

1. 与解析出的 ZCode API origin 精确一致；
2. 在 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 中登记的 **http loopback** origin。

因此指向本地时**必须**登记该 origin，否则请求在客户端就被拒绝，表现为
"官方 MCP 连不上"而非后端错误。该环境变量在
`packages/services/src/node.ts` 与
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` 两处读取
（host 与 CLI 各自传入，避免单侧校验）。

## 已知限制

- 仓库内**没有**本地搜图后端实现。指向本地后，在没有自行部署后端的情况下该插件
  不可用——这是预期状态，不是缺陷。
- 本地后端需要实现 `POST /api/v1/mcp/server/image_search`，并接受宿主注入的
  `Authorization` 头。它可以忽略该 JWT；协议上不要求校验。
- 端口 8787 是约定值，改默认端口时必须同步 `.env.development`。
- `userConfig` 的 `title` / `description` 是纯字符串，schema 为 `.strict()`，
  不支持 i18n 变体，因此描述用英文书写。

## 验收场景

1. `plugin.json` 通过 `zcodePluginManifestSchema` 校验（新增 `userConfig` 不违反 `.strict()`）。
2. 未配置任何用户选项时，`resolveTemplate` 把 URL 解析为
   `http://127.0.0.1:8787/api/v1/mcp/server/image_search`。
3. 在插件设置里把 `imageSearchBaseUrl` 改为 `https://api.z.ai` 后，URL 解析为
   官方路径，且不需要 loopback 登记即可通过 origin 校验。
4. 指向本地但未设置 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 时，
   请求被 `isOfficialMcpOriginTrusted` 拒绝，错误可归因到 origin 未登记。
5. `pnpm typecheck` 与 `pnpm lint` 保持基线。

## 实测结果（2026-09-21）

`adapters` 包当前没有 `test` script 与测试目录，按仓库约定不擅自引入测试设施，
因此用一次性脚本直接驱动真实的 `resolvePluginMcpServers` 验证。可复现命令：

```bash
# 构造 LoadedPlugin，读真实 .mcp.json 与 plugin.json，跑真实 resolveTemplate
node_modules/.bin/tsx /tmp/opencode/verify_mcp2.mjs
```

脚本要点：`loadPluginMcpServerDefinitions` 读 `.mcp.json` 与 manifest 内联两份定义；
`resolvePluginMcpServers` 返回的 key 带 `plugin:<pluginId>:` 命名空间前缀
（此处为 `plugin:image-search:image_search`）。

实测输出：

```
1. .mcp.json url      = ${user_config.imageSearchBaseUrl}/api/v1/mcp/server/image_search
   manifest url       = ${user_config.imageSearchBaseUrl}/api/v1/mcp/server/image_search
   diagnostics        = []                     # 无解析诊断

2. 默认解析 url       = http://127.0.0.1:8787/api/v1/mcp/server/image_search   PASS
   auth               = {"type":"zcode_official","provider":"jwt_token"}
   official provenance= {"mcpKey":"image_search","pluginId":"image-search@official","source":"plugin"}

3. 用户覆盖官方后端   = https://api.z.ai/api/v1/mcp/server/image_search         PASS
4. 覆盖端口          = http://127.0.0.1:9999/api/v1/mcp/server/image_search    PASS

总结: ALL PASS
```

第 3 项证实 `official` provenance 由宿主生成（`source: "plugin"`），
不是插件自己声明的——与 `buildOfficialProvenance` 的注释一致。

未覆盖项：第 4 条（origin 未登记时的拒绝路径）需要起一个本地 MCP 后端才能触发，
当前仓库没有该后端，留待实现本地后端时一并验证。
