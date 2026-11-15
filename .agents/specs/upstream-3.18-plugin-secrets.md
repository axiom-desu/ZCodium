# 上游 3.18 插件敏感配置存储（S4）

父 spec：`.agents/specs/upstream-3.18-sync.md`（官方 `.cache/upstream-3.18.2` @ `fec97590`）。
上游落点：`apps/zcode-cli/packages/adapters/src/config/plugin-secrets.adapter.ts`、
`apps/zcode-cli/packages/bootstrap/src/plugin-secrets.ts`、`bootstrap/tests/plugin-secrets.test.ts`。
留账更正来源：`.agents/specs/upstream-3.18-cq6-ledger.md` §2。

## 1. 范围

| 项                                       | 上游 3.18                                   | 本仓决定                                                                    |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| 私有文件 adapter（schema/权限/损坏备份） | `plugin-secrets.adapter.ts`                 | **移植**（§3），zod schema、`withFileLock`、`atomicWritePrivateTextFile`    |
| 分层叠加 / configure / reset / uninstall | `bootstrap/plugin-secrets.ts`               | **移植**（§4、§5）                                                          |
| 敏感键权威                               | manifest `PluginUserConfigOption.sensitive` | **复用既有字段**，不新增第二声明源                                          |
| 公开协议                                 | `plugins/readUserOptions`（扩展 settings）  | **只做 port**（§6）：本仓尚无该协议方法与扩展 Host，注册为 RPC 属未接线入口 |
| UI 表单                                  | 脱敏输入 / clear / scope 徽标               | **补齐**「已保存但不可回显」状态（§7）；其余已存在                          |
| D1 数据同步 / 导出                       | 私有文件不进同步包                          | 保持 `pickPortablePluginOptions` 过滤，并验证私有值不外泄（§8）             |

不做：不新增配置缓存、第二写入路径、通用 renderer 密钥读口；不改 root `package.json`/`knip.json`/CI；
不引入新依赖（zod 已在 `@zcode/adapters`）。

## 2. 唯一 owner 与事件顺序

```text
manifest.userConfig[key].sensitive = true
        │
        ├─ 写：configure(scope) ──▶ ① 私有文件（锁 + 0600 原子写）──▶ ② config.json 删敏感键写普通键
        ├─ 读：createConfig 产出各层 optionLayers ──▶ withPluginSecrets 按层叠加 ──▶ 单一 config 视图
        │        └─ 投影 configuredOptions 过滤 sensitive；optionSources 保留 scope
        └─ 生命周期：reset(user) / uninstall(全部 scope) ──▶ 删除私有条目
```

- **唯一解析器**：`applyPluginSecrets(configResult, file)`（bootstrap）。adapters 只做文件 I/O 与纯数据变换；
  没有任何独立配置缓存，`resolveZCodePlugins` 与协议投影各自叠加同一函数（只读原始层，幂等）。
- **唯一持久 owner**：敏感键只落在 `<cli storage root>/plugin-secrets.json`；`config.json` 不得保留同名字段的明文。
- 层序沿用原 file-config：`user` < 项目配置文件（发现顺序）< 最内层 workspace。私有值优先于同层旧明文值，
  scope 之间优先级不变。
- 事件顺序（写）：私有文件先写 → 再改 `config.json`。第二步失败时两处都有值，读取以私有文件为准，不丢值。
  反向不会发生：`config.json` 先删敏感键会让崩溃窗口丢值。

## 3. adapter 契约（`adapters/src/config/plugin-secrets.adapter.ts`）

- 文件形状：`{ version: 1, user: pluginId→key→value, workspaces: normalizedRoot→pluginId→key→value }`，`.strict()`。
- 值类型只有 `string | number | boolean`；非法形状视为损坏。
- 读：`ENOENT` → 空文件；解析/schema 失败 → 备份（`backupCorruptFile`，按内容哈希命名）后按空处理；
  其他 I/O 错误同样按空处理，原因区分 `corrupt | io`，诊断不带值。
- 写：`withFileLock`（同一路径跨进程共享 OS 锁）内读改写；损坏文件先备份（失败即抛错，不覆盖证据）再按空处理；
  内容未变且原文件有效、权限已受控时不写盘。落盘用 `atomicWritePrivateTextFile`（0600 + 同目录 temp + rename 重试）。
- 权限与链接：既有普通文件权限过宽时（读写路径都）收紧到 0600；即使内容不变也修正。symlink/FIFO 不跟随读取，
  写入时用新的 0600 普通文件替换；普通文件带硬链接时先收紧既有 inode，再用原子 rename 断开链接，后续秘密
  不会通过另一个路径可读。损坏备份失败必须抛错，原损坏文件保持原样。
- workspace 键按 `normalizePluginConfigPathForComparison`（win32 小写 + `/`）比较，手工编辑的分隔符/大小写差异仍匹配；
  不同 workspace root 的私有条目互不合并，显式清除只影响当前 root。
- 清理：删除后不留空插件条目、空 workspace 条目。

## 4. 分层读取

- `ConfigResult.sources.plugins` 新增 `optionLayers: PluginOptionLayer[]`（`scope`/`path`/`workspaceRoot?`/`options`），
  由 `createConfig` 填写：`user` 层（非 `skipUserConfig`）+ 每个已装载项目配置文件一层（`workspaceRoot = baseDir`）。
- `applyPluginSecrets` 只重算私有文件里出现过的 `(pluginId, key)`：从最内层向外取第一个「私有值或该层明文」，
  命中层决定 `optionSources[key]`；同时把私有值来源记到 `sources.plugins.secretKeys`，投影据此继续隐藏历史秘密。
- 幂等：同一 config 视图重复叠加得到同一值；`secretKeys` 只增不减，来源仍是私有文件。
- `createConfig` 保持同步、不读私有文件；叠加发生在 `resolveZCodePlugins`（异步）与协议投影前
  （`resolvePluginConfigView`），两者都只经 `withPluginSecrets`。

## 5. 写入与生命周期

`savePluginOptions({ configPath, secretsPath, scope, plugin{id,userConfig}, options, clearOptionKeys })`：

1. `sensitiveKeys` = manifest 中 `sensitive === true` 的键。
2. **迁移**：读该 scope 的 `config.json` 中该插件全部「按当前清单敏感」的旧明文键（含本次请求未带的键），
   写入私有值，并在 `config.json` 中清除。只迁请求里的键会让旧明文永久留在磁盘。
3. 请求里的敏感键进私有值；非敏感键进 `plainValues`。写普通键时同时清除私有文件中的同名键
   （清单把敏感键改回普通后，旧私有值不能盖住新写值）。
4. `clearOptionKeys` 同时作用于私有值与 `config.json`（显式 clear 才删，UI 不回传敏感值不等于 clear）。

- `reset(user)`：删 `config.json` 用户层足迹 + 用户层私有值。
- `reset(workspace)`：只删启用覆盖（「恢复继承」），保留 workspace options 与私有值。
- `uninstall`：`config.json` 用户层足迹 + 私有值**所有 scope**（`"all"`）；其他插件与其他 workspace 条目不受影响。

## 6. 读口边界

- 公开协议 `plugins/list` 继续只下发过滤后的 `configuredOptions`（当前 `sensitive` 键 + `secretKeys` 剔除）+
  `optionSources`（用于 scope 徽标与 clear 可用性），不回显实际值；缺失已配置插件条目同样按该规则投影。
  清单把敏感键改回普通后，旧私有值仍生效但继续隐藏，不能因当前清单不再标 sensitive 就回显。
- 运行期解析（MCP header/env 等 secret sink）从同一 `config.plugins.options` 取真实值；`adapters/plugins/mcp.ts`
  既有的 `allowSensitive` 门禁继续拒绝把敏感值展开到 url/args。
- 新增 `readPluginUserOptions({ pluginId, consumerPluginId })`（`bootstrap/src/plugin-user-options.ts`，经 `plugins.ts` 导出）：
  **user 视图**（不加载任何项目配置层）+ 只按 `pluginId` 取该插件的默认值/有效值。调用方必须由受信任接线传入
  `consumerPluginId`，缺失或与 `pluginId` 不同 → 抛 `plugin_user_options_forbidden`；插件不存在 → 抛 `plugin_not_found`；
  workspace 私有值永不进入。身份不能来自插件可控参数；当前源码没有注册 `plugins/readUserOptions` RPC，不能描述为已接线 RPC。
  它不是通用密钥读口：不注册协议方法、不进模型可见工具、不打印值。

## 7. UI

- 敏感字段已用 password 输入、空字符串表示「不修改」、`clearOptionKeys` 表示显式清除、并按 `optionSources` 显示 scope 徽标。
- 补「已保存但不可回显」可辨识状态：敏感键在 `optionSources` 有来源（即已有私有/旧明文值）且 `configuredOptions`
  未回显时，输入框给出占位提示（中英 i18n）。占位提示不参与提交，空值仍表示不修改。

## 8. 数据同步 / 导出（D1）

- `pickPortablePluginOptions` 已按 schema 丢弃 `sensitive`/`file`/`directory`，来源端与目标端各筛一次。
- 私有文件位于 `<cli storage root>/`，不属于 inline/marketplace 插件归档、`plugins/` 目录或 `config.json`，
  同步/导出不会携带它；迁移后 `config.json` 不再含敏感明文，普通字段保持不变。
- 真实 inline 导出/导入服务回归：尚未迁移的 legacy 明文、私有 `plugin-secrets.json` 与远端 payload 私带的敏感键
  都不能进入同步 items、归档或目标 `config.json`（`packages/services/test/pluginSecretsDataSync.test.ts`）。

## 9. 失败语义

- 私有文件不可读：按空叠加（旧明文仍生效），logger `warn`（`plugins.secrets.unreadable`，只带路径与原因），
  并向 `PluginLoadOutcome.diagnostics` 追加 `plugin_secrets_unreadable`（severity `error`，message/字段不含值）。
- 私有文件损坏：本次按空；下一次保存先备份再替换为有效内容，备份保留。
- `config.json` 写失败：私有值已生效，报错上传给调用方；不静默成功。

## 10. 验收

1. 真实文件层：configure 后敏感值只在私有文件（0600，POSIX），`config.json` 无明文且保留普通字段。
2. 旧明文迁移：只读解析不迁移、不建文件；下一次保存（即使只带普通键）迁走全部敏感明文，运行时仍取到值。
3. 运行期消费：值只在私有文件时 MCP secret sink 仍展开；非 sink 字段仍被拒绝且诊断不含值。
4. 分层：workspace 根键按 root 记录，最内层优先；清除最内层回落到外层 workspace；相邻 workspace 互不泄漏。
5. 投影：`plugins/list` 输出不含值，`optionSources` 仍报 scope；normal↔sensitive 后历史私有值继续隐藏；
   `readPluginUserOptions` 只返回该插件 user 值，其他插件 id 报 `plugin_not_found`，consumer 不匹配报
   `plugin_user_options_forbidden`，workspace 私有值不出现。
6. 生命周期：user reset / workspace reset / uninstall 的私有条目与 `config.json` 足迹符合 §5。
7. 文件安全与并发：损坏备份失败不覆盖原文件；跨进程并发共享同一锁；既有 0644 被修正为 0600；
   symlink 不被跟随、目标不被改写；hardlink 被断开且新 secret 不能从另一路径读到。
8. 数据同步：真实 inline 导出/导入不带走敏感键、legacy 明文或私有文件，导入端也不写回敏感键。
9. UI：真实 Chromium 验证脱敏输入、「已保存」占位、空输入 keep、显式 clear（敏感与普通字段）与保存 patch。
10. 未加载 pluginId：configure 直接失败，既不写 `config.json` 也不创建私有文件。

测试命令（临时 HOME/XDG，不读真实用户数据）：

```bash
node --import tsx --test --test-isolation=none apps/zcode-cli/packages/bootstrap/test/plugin-secrets.test.ts
node --import tsx --test --test-isolation=none apps/zcode-cli/packages/adapters/test/plugin-secrets-adapter.test.ts
node --import tsx --test --test-isolation=none packages/services/test/pluginSecretsDataSync.test.ts
PLAYWRIGHT_BROWSERS_PATH=<已安装浏览器缓存> pnpm vitest run --config packages/ui/vitest.config.ts packages/ui/test/pluginSecretsForm.chromium.test.ts
```
