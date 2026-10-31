# S12：文件管理器导航面板（preview + directory 分栏）

来源：3.16.2 `3c5b2276` 的 `FileManagerPane`。父规格：`upstream-3.16-settings-and-navigation.md`「文件管理导航」。
本规格只覆盖 UI 侧文件管理器面板，不改动文件服务、目录读取与预览 owner。

## 范围与不变量

```text
Sources tab (code-viewer) ── source ──┐
                                      ├─→ FileManagerPane（本规格新增，生产组件）
workspace 目标 (identity/path/remote) ─┘        │
                                               ├─ header 容器 → PreviewPane 面包屑（portal）
                                               ├─ preview panel（现有 PreviewPane）
                                               └─ directory panel（现有 WorkspaceFileTree）
```

- PreviewPane 仍是文件预览唯一 owner；WorkspaceFileTree 仍是目录读取/展开/刷新唯一 owner；
  `useWorkspaceFileTreeData` 的 workspace generation + 目录请求序号继续负责丢弃迟到目录结果。
- FileManagerPane 只做布局、显隐偏好与导航转发：点击目录行不新建 tab，只把新 `source` 写回当前
  code-viewer tab（`navigateCodeViewerSidePane`）。不新建文件服务、不缓存目录事实。
- 现有 pointer 拖拽、side-pane-full-view 与分屏 guard 不改：面板仍是同一个 `ResizablePanel`，
  完整视图只换外壳；FileManagerPane 只在内容区内部再分 preview/directory 两栏。

## 显隐偏好唯一 owner

```text
用户点 header 开关
  → setFileManagerNavigationOpen(workspaceKey, next)   # store 唯一 writer
  → localStorage "zcode-file-manager-navigation-preferences" ({ [key]: boolean })
  → 同 key 的所有 FileManagerPane 重新渲染

workspace 切换 / 应用重启
  → loadFileManagerNavigationPreferences()（坏数据 → {}）
  → 缺席即默认展开
```

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`。同一路径挂到不同远端/连接世代时，
  只要 identity 存在就不会串偏好；identity 为空时才回退本地路径。
- 空 key 不写入（`setFileManagerNavigationOpen` 直接返回）。
- 显隐偏好是 UI 偏好，不是远端目录事实；不得由 Host/服务持久化。
- 紧凑布局（容器宽度 < 384px 或移动 overlay）里「选中文件后自动收起」只落在当前面板的
  `compactNavigationOpenOverride`，**不写偏好**；用户手动点开关才写偏好并清空临时覆盖。

## 收放与布局

- 目录栏显隐必须用 panel 的 `collapse()/expand()`（以及 `ResizablePanelGroup` 的 `disabled`），
  不能用 `hidden`：`hidden` 会留下外层占位，宽度恢复时出现空洞或首帧抖动。
- 目录栏 `defaultSize=192px`、`minSize=160px`、`maxSize=60%`；紧凑布局下目录可占 100%，
  此时 preview 收起。
- `layoutId="file-manager-layout"` 只持久化分栏宽度；显示状态由上面的偏好 owner 决定，二者不互相覆盖。
- header 高 40px：左侧是 PreviewPane 面包屑的 portal 容器（无 source 时显示 `fileManager.title`），
  右侧是开关按钮；`aria-expanded` 反映真实显隐。

## 失败与迟到语义

- 目录读取失败/断连：沿用 `WorkspaceFileTree` 现有错误提示与保留旧树的规则，不在 FileManagerPane 兜底。
- 切 workspace 或连接世代变化后，旧目录响应不得覆盖新目录（由 `useWorkspaceFileTreeData` 的 generation
  守卫保证，本规格只要求不绕过它：不得把旧目录快照塞进 FileManagerPane 自己的 state）。
- 偏好读取失败（JSON 损坏/类型不符/Array）→ 全量回退默认展开，不抛错。

## 验收

- 单元（vitest）：`fileManagerNavigation` 纯函数（key 归一化/紧凑推导/默认展开）与 store 偏好
  （同 key 重建恢复、不同 workspace 隔离、坏数据回退）。
- 浏览器 E2E（生产组件 `packages/ui/test/fixtures/file-manager-pane.jsx`）：
  临时 workspace 目录 + 注入的 FileService（loopback，可延迟）；断言默认展开、目录真实行、
  点文件后预览与面包屑、目录刷新、开关收放与宽度恢复、切 workspace 后旧目录迟到响应不覆盖、
  偏好按 workspace 隔离且刷新后恢复、窄容器选中文件自动收起且不写偏好；`?mode=panel` 时把同一
  FileManagerPane 嵌进真实 `AnimatedSidePanePanel` 的 code-viewer tab，验证目录行导航不新建 tab、
  不更换 tab 身份；全程无外部请求/页面错误。
- 回归：`pnpm vitest run --config packages/ui/vitest.config.ts`（本规格新增用例），
  `node scripts/ci/side-pane-full-view-smoke.mjs`、`node scripts/ci/workbench-split-guard-smoke.mjs`。
