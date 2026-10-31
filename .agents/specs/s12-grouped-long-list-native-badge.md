# S12：分组长列表与 Windows 可见数字

来源：只读核对 `3c5b2276` 的 TaskGroupedView / grouped/useGroupedDrag / grouped/drag 与 unreadBadge。
上游最终任务栏接线实际仍为红点（文档早期数字目标与最终代码不一致）；本任务明确要求恢复可见数字，不能把红点适配视为获批。
父规格：upstream-3.16-project-integration / upstream-3.16-settings-and-navigation。

## 所有者与顺序

```text
单一 readTree → ProjectGroupedView 权威行
pointer → UI gesture（origin/preview/point/RAF）
        → 最近真实 overflow-y viewport 边缘 RAF scrollTop
        → 每帧重新命中屏幕行 → 临时 preview
        → pointerup → 既有单 moveTaskGroupNode → Repo source/anchor CAS → 同一树刷新
Esc / pointercancel / blur / epoch 换代 / unmount → cancel RAF + 移除监听 + 丢 preview → 零写入

Host unread → 原窗口计数 → Main max（非 sum）→ label 1…9 / 9+ → native image
窗口关闭 → 删除该窗口投影 → max 重算；0 → null overlay
```

- 手势不创建第二 readTree、业务缓存或写通道；真实滚动容器只在手势期间持有。
- pointer 不移动也持续 edge scroll；速度随边缘距离变化，按 RAF 时间推进；离开边缘、边界或结束即停止。
  滚动后重算落点，不能拿滚动前 rect 提交。旧 pointer/旧 epoch 不操作新手势。
- 只提交一个被拖节点与 anchor；折叠、legacy、归档、pinned 等隐藏成员不参与快照覆盖。
- 保留现有 preview/浮层/指示线；本切片不声称移植完整动画、虚拟化或 sticky。
- native 图只用纯像素 bitmap（无字体/新依赖）；16/32 各自绘制抗锯齿红底白色 1…9/9+，
  输出遵守 Electron 原始 bitmap 的预乘 BGRA 字节契约（颜色为 RGBA 语义，不传 PNG/SVG 冒充原始像素）。
  托盘继续红点；Main 不持任务事实。label cache 仅允许十种规范文案，非法输入清除，容量最多十张。
- CLI plugins-command.ts 仅按读/校验职责拆分；runPluginsCommand、类型导出、usage、DI、stdout/stderr JSON、exit code 不变。

## 验收（先红测试）

- 生产 WorkspaceSidebar / ProjectGroupedView + 真实 ProjectService/临时 SQLite + 生产 CSS：长列表 pointer preview →
  不借助测试滚轮/scrollIntoView 的 edge scroll → 原屏外目标 drop，恰一条命令；Esc/取消/换代零写，隐藏成员顺序不改。
- RAF 单测覆盖上/下、静止指针、实际 scrollTop、停止/卸载回收、边界与离开 viewport。
- bitmap 单测 16/32 的 1/2/9+ 像素不同、白字与红底、透明边缘和预乘；adapter 真调用表示装配，
  0 清除、窗口关闭 max 回落、计数更新、cache 上限。Linux 测试不冒充 Windows 真机验收。
- Node 24.14.0 绝对路径；根 typecheck/raw lint/fmt/arch、CLI 独立 types/lint/fmt 与实际浏览器测试记录真实结果。
  不改其它 worker 的 ProjectSidebarSection，不改 ignore/baseline，不操作真实用户文件。
