# P4：Provider 兼容窄修

父 spec：`upstream-3.17-sync.md` §P4。权威来源：
`git diff 3c5b2276 a9fe401e -- packages/provider/src/resolver.ts packages/provider-node/src/zcode-builtin-provider-config-source.ts`。
本片不代表 Provider 域整体对齐。

## 核对结论与边界

- 交付：Resolver 缺失 Logo 的只读展示补齐，不改变模型、凭据、请求、Registry 准入或配置写入。
- **暂缓 Bundled LKG**：上轮草稿把「本仓 Bundled 可写」判为与上游兼容不准确。
  本仓 `packages/desktop/src/main/desktopProviderConfig.ts#getBuiltinProviderConfigFileInfo`、
  `packages/ui/src/TaskActionMenuContent.tsx` 的「前往配置」明确开放运行时生效的可写物化副本；
  `NodeZCodeBuiltinProviderConfigSource` 监听该文件并接受运行中修改。
  `materializeZCodeBuiltinProviderConfig` 也可能按同一路径重新物化，而非不可变安装资源。
  此时模块级 LKG 会把最近读到的用户修改提升为文件删除后的进程内事实，不同实例的读时序还会影响结果。
  与上游「Bundled 在进程生命周期内不可变」的依据冲突，须先对齐删除/重置和缓存失效语义，不硬加回退。
- 本仓已删除 Active/远端下载所有者，当前 Source 只有 `bundledFilePath`、`watch`，无候选选择或 Active 重建。
  不为套用上游修复重建已移除模块。
- 不修改 HTTP 下载准入、catalog/config、root package/lock、其他并行切片；不 commit/push。

## 唯一所有者与接口

| 事实                  | 所有者                               | 本次变化                                           |
| --------------------- | ------------------------------------ | -------------------------------------------------- |
| Provider 分层计算结果 | `ProviderConfigResolver.resolve()`   | 在原 Overlay 后仅补 Logo，不持久化、不新增服务状态 |
| 模板展示素材          | 输入 `zcodeBuiltinProviderTemplates` | 每次 resolve 构造局部索引，不保留跨调用缓存        |
| Bundled 文件事实      | 物化副本 + 既有 Source 读取/监听     | 保持原行为，无 LKG、Active、新写者                 |

## Logo 规则

1. 遍历模板，仅对同时具备 `api.type`、非空 `api.baseUrl`、`logo` 的模板建立索引；
   key 为 `` `${api.type}:${api.baseUrl.replace(/\/+$/, "")}` ``。
   只去尾斜线，不做 trim、大小写、host、路径、query 或协议转换。
2. 同 key 不同 `logo.key` 永久判为歧义，即使后续又遇到同 key 同 Logo 也不恢复；
   同 key 同 `logo.key` 可补。缺 api/logo 的模板不参与索引。
3. 在 `effectiveBuiltinProviders.overlay(templatePersonalProviders)` 之后，仅对
   `config.logo === undefined` 且 api 两字段完整的 Provider，匹配并 Overlay `new ProviderConfig({ logo })`。
   不要求存在或缺少 `templateId`，不叠加整份匹配模板。
4. 已有 Logo（包括显式 null）原样保留。无模板时不改变结果。
5. `access`、api（尤其原始 URL 与 headers）、模型成员/顺序、visibility/group、enabled、
   templateId/providerName 不变；Resolved/Registry 的成员顺序、模型结果、资格与 issues 不变。
   补齐可出现在其 config.logo，但不得改变请求行为或触发写入。

```text
builtin + account → 模板 overlay → personal overlay → effectiveProviders
模板输入 → 局部索引 (api.type + 去尾斜线 URL → logo；歧义禁用)
                                                    ↓
                                  仅缺失 logo 时补齐
                                                    ↓
                           原有 resolve / Registry 准入（不变）
```

## Bundled 后续对齐条件（本次不实现）

若明确批准 LKG，须限定规范化路径 `resolve(filePath)` 的进程内缓存，只缓存成功解码的 Release，
跨实例共享；仅 ENOENT 可回退，JSON/schema 损坏与其他 IO 错误不能回退或污染缓存；
无 LKG 时保留原始文件错误（code/path），不回写 Bundled。当前不存在 Active，不能声称已验收跨实例
重建 Active。还须明确运行中编辑、删除、重新物化、并发读取与失效顺序，避免把缓存变成另一配置权威。

## 先测试后实现

`packages/provider/test/resolver-template-logo.test.ts`（Vitest）：

- 两侧尾斜线匹配；相同 key 同 Logo 可补；不同 Logo 歧义不可恢复。
- api type、URL scheme/大小写/非尾部路径/query 不同不补；api 不完整不补。
- 已有 Logo、显式 null、模板不完整、无模板时保持原行为。
- Built-in/个人/账号 Overlay、templateId 及显式模板语义保持；补齐不更改模型、凭据、headers、
  原始 URL、顺序、enabled、issues 或 Registry 模型准入，输入不被修改。

`packages/provider-node/test/zcode-builtin-provider-config-source.test.ts`（Vitest，临时目录）：

- 固化本仓可变事实：同一 Source 和新实例均读到运行中修改，revision 更新。
- 文件删除仍报原始 ENOENT（code/path）；损坏仍报解码错误，不静默回退；Source 不重建文件。
- 所有内容均为合成 fixture，watch 关闭；仅访问临时目录，不读真实用户数据与日志。

## 验收

实际执行两包 Vitest、typecheck、lint、格式检查及 root `pnpm typecheck`、`pnpm lint`、
`pnpm architecture:check --changed`，记录真实结果。两包目前未纳管，不新增跨包依赖。
Node pin 为 24.14.0；当前 shell 为 24.19.0，未修改 pin。

### 实际验证记录

- 修改实现前：两包 28 项中 Logo 正向场景 8 项失败，其余 20 项通过；修改后 28/28 通过。
- 两包 `typecheck`、两包 `lint`、root `pnpm lint` 均通过（lint 无 warning/error）。
- 两个新增测试文件额外以 `tsc --noEmit --ignoreConfig --module ESNext --moduleResolution bundler
--target ES2025 --lib ES2025,DOM --types node --strict --skipLibCheck --esModuleInterop` 检查通过。
- `oxfmt --check` 检查两包 `src/test` 与本 spec 通过。首次检查整个包目录失败：扫到 74 个既有/生成的
  `dist` JS/d.ts 格式问题；没有改动这些生成产物。
- root `pnpm typecheck` 已执行但失败：当时并行 RPC 测试存在泛型 mock/node:buffer 类型错误，remote
  backend 测试与实现尚未对齐，attachment 测试引用尚未创建的模块。未改动或掩盖这些其他切片错误。
- `pnpm architecture:check --changed` 通过（baseline/new 均为 0），无新增跨模块边界。
- Vitest 与主检查在临时 HOME/XDG/data 环境运行，fixture 仅访问临时目录；不读真实数据或日志。
