# App 显式会话导航桥

本模块实现 SCT03 的桌面传输适配器：Host 的 `AppControlNavigationPort` → 父端口 → Main 窗口 surface →
preload IPC → renderer 既有导航 owner。项目授权与目标解析由 `AppControlService` 负责；本模块只关联
请求、可信窗口、renderer generation、取消和回执，不持有会话事实或 accepted queue。

```text
AppControlService → Host bridge → Main window bridge → platform → Root actions
                         ↑             ↑                         ↓
                   scope / abort   generation guard ← 实际导航提交回执
```

- Host 的 `uiTarget` 只来自 Main 在 `init-local` 中绑定的 `window:<BrowserWindow.id>`；显式目标从 Main
  当前窗口注册表解析，缺失即 `ui-target-unavailable`，不回落到当前窗口。
- Renderer 在 Root 动作挂载后登记能力；卸载、reload、`render-process-gone`、窗口关闭、Host 退出或
  替换都会使在途请求失效并清理 pending。未登记 renderer 立即 `unavailable`。
- 发送事件不表示 opened。只有匹配请求、当前 generation 的真实导航回执可以返回 opened，Host 收口时
  复验可信连接代际。取消发送同一 requestId 的撤销事件，renderer 在异步边界复验 signal。
- 手机/Web 不登记该 IPC 能力，不接收桌面导航；没有导航 owner 的 Host 不注入该端口。
