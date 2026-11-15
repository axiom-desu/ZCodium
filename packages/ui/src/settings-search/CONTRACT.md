# settings-search

设置页「按名称搜索设置项并定位到具体行」的 UI 模块。

- 状态：只持搜索查询草稿与结果选择；不持有设置值。
- 唯一导航目标所有者为 `SettingsPage`（`{ id: SettingsSearchId }`）。本模块只产出
  `SettingsSearchResult` 并交给调用方的原分类导航。
- 索引（`settingsSearchIndex.ts`）只引用现有翻译 key 与稳定 `searchId`；不索引配置值、密钥、
  动态资源正文，也不登记本仓已移除的设置行。
- 可见性由调用方注入（`SettingsSearchAvailability`），沿用现有平台投影，不新增缓存/请求。
- 公共入口：`index.ts`（组件/context/hook）、`contract.ts`（结果与 id 类型）。
