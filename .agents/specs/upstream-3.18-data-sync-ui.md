# 上游 3.18.2 数据同步 UI（U3）：统一数据同步页与弹窗

- 上游来源：`zai-org/ZCode@fec97590`（3.18.2），区间 `3c5b2276..fec97590`。
- 参考（只读）：`.cache/upstream-3.18.2/packages/ui/src/data-sync/**`。
- 消费的上游服务契约由 D1 在本仓实现（`packages/services/src/data-sync/**`、
  `provider-provisioning-status/**`、`packages/shared/src/remote-sync.ts`）；本切片只做 UI，不新增第二套
  同步服务、远端 manager、Host 或 Agent。
- 不在本切片：旧连接向导/Header/侧栏项目菜单入口、项目恢复/删除（U4/D2）、CLI 发现（C8）、MCP/CAS/
  remote commit 策略（S1）、遥测/off-peak/highspeed/CUA 休眠（本仓已移除，不恢复）。

## 唯一所有者

| 状态                                       | 唯一所有者                                                                   | 说明                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 弹窗请求 / 最小化 / 推送结束结果版本       | `app/dataSyncDialogStore.ts`（窗口内 zustand store）                         | 所有入口只发 `open(request)`；已有实例时恢复，不替换设备；不做 IO。            |
| 弹窗实例（分类、勾选、推送 session、哈希） | `app/useDataSyncDialog.ts` 一次调用                                          | Store 只保存请求；弹窗组件挂载一次，最小化只隐藏模态内容。                     |
| 各分类条目内容                             | 既有配置服务（D1：`mcp-sync`/`skill-sync`/`plugin-sync`/`user-config-sync`） | UI 只读投影 + 发命令；不缓存权威内容，不写配置文件。                           |
| 设备同步状态                               | 本机 Host `IDeviceSyncStateService`（`base.deviceSyncStateService`）         | 设备行「上次同步」与推送后写入都只经本机 base 服务；不读远端、不进手机白名单。 |
| Provider Provisioning lane                 | 本机 Host `IProviderProvisioningStatusService`（唯一数据源 Main 协调器）     | 分类页只读状态 + `retry`；没有 lane / 无服务时显示 `none`，不伪造结果。        |
| 目标端连接                                 | 既有 `sourceSettingsServiceStore` + `requestSourceSettingsAttachment`        | 复用当前 Source 连接注册表与代际；不新建 Host、连接、Agent 或配置缓存。        |

`DataSyncDialogHost` 的唯一挂载点是 WindowRoot（`Root`），因此最小化、关闭/切换设置页时推送 session 仍不卸载；所有旧同步入口只写入现有 dialog request store，不另挂 dialog owner。

## 事件顺序

```text
设备行「同步」 → store.open({sourceServerId}) → Host 从管理快照解析设备/在线 → 目标端 attachment
  → generation = online && targetServices
  → list(source) ∥ list(target) → selectHashRequests → contentHashes(两端) → compare → 默认勾选
勾选 → export(source, batch) → checkSyncWriteAccess(target, 15s) → import(target, CAS)
  → per-item created/updated/skipped/conflict/failed → 只失效受影响目标哈希 → list(refresh)
  → afterPush 串行队列（不等待） → 推送结束 → onPushFinished(result) → 本机设备同步状态
离线/换代 → generation+1 → 进行中推送标 failed → 结果作废（不上报成功） → 重新在线后重新加载
最小化 → 只改显示状态；generation / push session / 分类 / 勾选不变
```

约束：

- 推送按分类串行；同一分类按字节分批串行；父子技能同批且上级在前（`parentKey` 链）。
- `overwrite` 必须带列表加载时的 `expectedTargetHash`；冲突只标记该项，不写文件，不重试。
- 推送永不删除目标端独有条目：比较只为来源端条目生成行，目标端独有 key 不展示、不发送。
- 推送中禁止关闭弹窗，没有全局取消；marketplace 插件可在远端 add/install 阶段按行「停止」。
- 迟到结果按 push session 身份 / generation 丢弃；旧连接的异常不能覆盖新 session 状态。
- 最小化后状态条可恢复；结束后不自动展开。

## 服务能力缺失（旧远端）

旧 Server 缺少 `IDataSyncCategoryService` 五方法或 `user-config-sync` 时，RPC 得到
`method-not-found`（`-32601` / `Method not found: ...`）。分类置为显式 `unsupported`：

- 不显示成「0 项 / 已同步」空成功；不参与「推送全部」，也不写入成功结果。
- 文案区分「设备不支持该分类」与普通加载失败；重试仍可用（重新在线/升级后重新加载）。
- `providerProvisioningStatusService` 缺失（非桌面 base 或旧 Host）时 lane 显示 `none`，不提供重试。

`error.code === -32601` 与 `/method not found/i` 之外不猜测；其他错误仍按加载失败处理。

## 平台边界

- 设置页只在**桌面 base（本机）设置**出现「数据同步」分区：`isDesktop` 且当前设置作用域不是远端
  workspace。Web / 手机远控没有 `requestSourceSettingsAttachment`、`deviceSyncStateService`、
  `providerProvisioningStatusService`，因此不显示分区；不修改手机 RPC allowlist，也不放宽策略。
- 目标端只用该设备的 source-settings attachment；不打开 workspace tab、不创建第二 Host。
- 转录 / 设备列表 / 扫描结果不回传手机；本机同步状态不进入远程 RPC 合同。

## 模块与文件

新模块 `packages/ui/src/data-sync`（managed manifest `module.ts`；policy 登记由整合方 G1 完成）：

- `contract.ts` / `contract.example.ts` / `CONTRACT.md` / `module.ts` / `index.ts`
- `domain/`：`compareRows.ts`、`compareBatches.ts`、`providers.ts`、`marketplacePlugins.ts`、`devices.ts`
- `app/`：`dataSyncHashCache.ts`、`dataSyncCategoryLoad.ts`、`dataSyncPush.ts`、
  `useDataSyncDialog.ts`、`useDataSyncProviders.ts`、`marketplacePluginSync.ts`、`categories.ts`、
  `dataSyncDialogStore.ts`
- `ui/`：`DataSyncDialog.tsx`、`DataSyncCategoryPanel.tsx`、`DataSyncOverviewPanel.tsx`、
  `DataSyncDialogFooter.tsx`、`DataSyncProvidersPanel.tsx`、`DataSyncMinimizedProgress.tsx`、
  `DataSyncDialogHost.tsx`、`DataSyncSection.tsx`

接线（窄）：

- `SettingsPage.tsx`：分区渲染 + 在设置页根挂 `DataSyncDialogHost`（唯一弹窗 owner）。
- `settingsPageConfig.ts` / `lib/settingsNavigation.ts`：新增 `dataSync` 分区 id（仅桌面 base 可见）。
- `i18n/locales/en-US.ts`、`zh-CN.ts`：新增 `dataSync.*` 前缀 key（本切片独占前缀）。
- 不改 `packages/services`、`shared` 契约、`architecture-policy.yaml`、`Remote*SyncDialog`。

## 与上游的差异（有意）

1. 上游 `DataSyncDialogProvider` 挂在窗口 Root；本仓设置页是唯一消费面，Host 挂在配置了 `SettingsPage`
   的层（切换分区不卸载），入口收敛到数据同步分区。跨窗口入口（Header/连接向导/项目菜单）留待整合。
2. 上游设备行「连接」按钮复用全局连接向导；本仓设置页没有该回调，离线设备只显示状态与提示，不新增
   第二连接路径。
3. 上游 marketplace 镜像预检 `inspectMarketplaceSourceMirror` 在本仓 `IPluginSyncService` 不存在：
   不新增服务方法，镜像来源在导出阶段按 marketplace 独立 try/catch，失败记为 `unavailable` 并由导入
   逐项报错；`cross-marketplace-dependency` 不作为列表预检态展示。
4. 不移植 `reportTelemetryEvent` / `withPluginTelemetry`（遥测已移除）。
5. 密钥只以掩码展示（末 4 位），明文不进入弹窗状态或日志。

## 验收

- `packages/ui/test/dataSync.test.ts`：比较行状态/默认勾选、哈希请求、父子分批、三态、
  依赖提示、marketplace 来源计划/条目、provider 掩码与 lane 展示、旧远端 unsupported 判定、
  设备投影与离线、设备同步状态写入/结果版本。
- `scripts/ci/data-sync-ui-smoke.mjs`：真实 `DataSyncDialog` + 真实比较/推送 Hooks，在 Chromium 中
  用临时服务替身（临时 HOME 语义的内存文件库）走「概览→比较→冲突→重新同步→写入」与
  「Provider lane 失败→重试→成功」，断言 DOM 状态与写入记录；不读真实用户数据、不连真实远端。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`oxfmt --check`（仅本切片文件）。
