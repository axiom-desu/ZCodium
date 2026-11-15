# Upstream 3.18.2 SCOPE5: settings-scope real consumption

Companion of `upstream-3.18-l1-locale-settings-scope.md`（L1 建立了 `settings-scope` 模块本身）。
本切片只做「消费者接线 + 未用导出收敛」，不重写 L1 的 owner，也不新增第二个 Scope 状态。

## 唯一 owner 与依赖方向

```text
配置目录目录表(useConfigDirectoryCatalog) ─┐
Source 管理快照(useSourceServerManagementSnapshot) ─┤
平台能力(requestSourceSettingsAttachment) ─┘
        │
        ▼
settings-scope/app/useSettingsScope  ← 唯一 Scope 状态 owner（沿用 L1）
   ├─ groups              → SettingsScopePicker（按设备分组）
   ├─ resolution          → ready / offline / missing 三态
   ├─ user                → 本机 base services 或该设备 source-settings services
   ├─ resolveSettingsScopeBlock → SettingsScopeBlockedNotice（fail-closed）
   └─ toLocalScopeKey / toPageScopeKey
        │
        ▼
packages/ui/src/settings/HooksSection（本切片的真实生产消费者）
   ├─ 列表读写：workspace target → 该 target 自己的 workspace 服务解析（不借用当前 tab）
   ├─ 远端「用户」 → 只经该设备的 source-settings attachment services
   ├─ 表单 owner → settings-scope/app/useSettingsScopeForm（设备级归属）
   └─ 表单内菜单 → 只列当前设备的 targets（SettingsScopeDeviceProvider）
```

`settings/` 属于 ui 模块（unmanaged），只经 `@/settings-scope/index.js` 公开入口消费；
`settings-scope` 不反向依赖 `settings/`，无环。

## Scope key 规则（唯一实现）

- 设备：`"local"` / Source 设备 `sourceServerId` / 其他远端 `hostId`。
- 「用户」：本机 `"user"`，远端 `source-user:<sourceServerId>`，项目为 `getWorkspaceKey(path, identity)`。
- 分区与表单内部只用设备内 key（「用户」统一 `"user"`），经 `toLocalScopeKey` / `toPageScopeKey` 转换。
- 页面 key 与设备 key 的转换、设备分组、默认选中都只有 `domain/scope.ts` 一份实现；
  `settings/PluginScopeMenu.tsx` 改为 re-export，不再保留第二份等价函数。

## Fail-closed 边界

| 状态                                                 | 判定                                       | 行为                                                                                              |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 设备离线                                             | 管理快照 `state !== online`                | `resolution = offline`，`SettingsScopeBlockedNotice(offline)`；不回退本机、不回显旧快照、不发 RPC |
| 外设备目标不可用                                     | `target.configOnline === false`（catalog） | 同 offline，禁止把当前 Host 的服务当作该设备服务                                                  |
| 远端「用户」attachment 未就绪                        | `user.status === "connecting"`             | `BlockedNotice(connecting)`，列表与表单都不渲染                                                   |
| 平台无 `requestSourceSettingsAttachment`（Web/手机） | `remoteUserAvailable = false`              | 不提供远端「用户」选项，`source-user:` key 解析为 `missing` 并回退到本机「用户」                  |
| 项目已关闭                                           | `missing`                                  | 回退同设备「用户」，表单按 fallback 设备判定，不跨设备保存                                        |

## 事件顺序

```text
用户选择 Scope → scope.setSelectedScopeKey(page key)
              → resolution(target/local user/remote user)
              → HooksSection 解析服务（target 自身 / 设备 source-settings / base）
              → hooksStore.initialize(target, services)
打开/关闭表单 → useSettingsScopeForm.openForm/closeForm（设备 owner）
              → 设备切换时表单在渲染期清掉，旧设备内容不会写给新设备
```

## 未用导出收敛（本切片清理，不隐藏）

- `settings-scope/contract.ts`：删除无消费者的 `IServiceAccessor` re-export（仍从 `@zcode/services` 内部引入）。
- `settings/RemoteSyncActions.tsx`：删除 `useRemoteSyncDialogIntent`（L1 后入口统一走 `dataSyncDialogStore`，无消费者）。
- `apps/zcode-cli/packages/adapters/src/mcp/pool-lease-cancel.ts`、`pool-snapshot.ts`：
  `LeaseCancellation(Options)`、`PoolSnapshotReaderOptions` 只在同文件内使用，去掉 `export`，不删除类型。
- `packages/shared/src/locale.ts`：`LegacyPersistedLocale` / `LegacyPersistedLocalePreference` /
  `PersistedSettingsLocaleFields` 是模块内部持久化形状，去掉 `export`。
- `knip.json`：按既有 managed module 约定登记 `settings-scope` 的 `index.ts` / `contract.ts` /
  `module.ts` / `contract.example.ts` 入口（与 `data-sync`、`settings-search` 同形），不写 ignore，不改基线。
- `architecture-policy.yaml`：登记 `settings-scope` managed 模块（roots/requires/publicEntrypoints/layers/owner），
  与 `module.ts` 一致。

## 验收

- Hooks 页的设备分组菜单来自 `useSettingsScope().groups`；选中离线设备/离线项目时只渲染阻断提示。
- 远端「用户」只使用该设备 source-settings 服务；本机「用户」不使用远端服务；表单切设备后在渲染期清除。
- Web/手机无 `requestSourceSettingsAttachment` 时不出现远端「用户」选项（默认拒绝新能力）。
- `settings-scope` 的真实入口被 `settings/` 消费；`pnpm gate:knip` 的 SCOPE5 22 项不再以新增出现。
- 语言选择器在真实 Chromium 中切到 ja-JP/ko-KR/ru-RU 并落盘（localStorage + settingService），390px 无横向溢出。
