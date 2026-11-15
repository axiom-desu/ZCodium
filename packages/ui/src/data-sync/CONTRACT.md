# data-sync

设置 → 数据与统计 → 数据同步页及其同步弹窗（`.agents/specs/upstream-3.18-data-sync-ui.md`）。
只在桌面本机 base 设置页显示；Web / 手机远控没有本机设备状态与 attachment 能力，不开放入口。

- source = 本机 base services；target = 设备的 source-settings attachment（`useSourceSettingsServices`），
  不打开 workspace tab，不新建 Host、连接或 Agent。
- `domain/compareRows.ts`：行状态、默认勾选、哈希请求、依赖提示。`domain/compareBatches.ts`：三态、分批、
  设备结果汇总。分批时子技能跟随最上层的已选上级（`parentKey` 链）放进同一批、上级在前。
- `app/categories.ts`：分类适配器注册表。新增分类 = 服务实现 `IDataSyncCategoryService` + 在
  `DATA_SYNC_CATEGORIES` 注册 + 文案 `dataSync.category.<id>`。
- `app/useDataSyncDialog.ts`：弹窗状态唯一 owner（选择、加载、推送、generation）；加载与推送分别由
  `dataSyncCategoryLoad.ts` / `dataSyncPush.ts` 执行，状态只在 hook 内落盘。
- 模型提供商（只读，不是 `IDataSyncCategoryService`）：`domain/providers.ts`（掩码行、lane 展示态）+
  `app/useDataSyncProviders.ts`（本机 `providerSettingsService.getView()` 与 `providerProvisioningStatusService`
  的 lane 状态 / 重试）+ `ui/DataSyncProvidersPanel.tsx`。不参与勾选与「推送全部」；最近结果的唯一数据源是
  Main 协调器的 lane。
- `app/dataSyncDialogStore.ts`：窗口内请求、最小化与结果版本；所有入口只发打开命令，已有弹窗时恢复同一实例。
  `ui/DataSyncDialogHost.tsx` 是唯一弹窗挂载点（WindowRoot）：申请 attachment、读取设备在线、落盘设备结果；设置页关闭或切换不卸载推送 owner。

不变量：

- 弹窗绑定设备的一次连接（generation = `online && targetServices`）。换代时进行中的推送标为失败并写入
  设备同步状态；迟到结果按 push session 身份丢弃；重新在线后重新加载。
- 推送中禁止关闭弹窗，没有全局取消。marketplace 插件行在目标端 add / install 期间可按行「停止」，
  停止只让该项以「已停止」失败，不影响其他项与 push session。
- 最小化只卸载模态内容，保留状态 owner；右下角状态条可恢复，结束后不自动展开。
- 推送按分类串行；每次推送结束后调用一次 `onPushFinished`，设备行只从设备同步状态读取上次结果。
- `afterPush` 只刷新运行态，不属于 push session：进入弹窗内串行队列，按推送顺序执行，失败只记日志。
- 推送永不删除目标端独有条目；黄色「差异」项默认不勾选，用户可手动勾选覆盖。
- 旧 Server 缺方法 → 分类 `unsupported`（typed），不显示为空列表 / 已同步，不参与推送。

```text
open → list×2 → contentHashes（两端都有的项）→ compare → 勾选
     → export → checkWriteAccess(15s) → import(createOnly|overwrite, expectedTargetHash)
     → 分类结果 → 重新 list（只重算受影响项的哈希）；afterPush 刷新进入串行队列（不等待）
     → 推送结束 → onPushFinished(success|partial|failed)
offline → generation+1 → 推送中分类 failed → 禁用操作；online → 重新加载
```
