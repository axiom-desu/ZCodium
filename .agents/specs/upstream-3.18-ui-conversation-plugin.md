# 上游 3.18 会话 / 图片 / 插件表面（Scope B）

父 spec：`.agents/specs/upstream-3.18-sync.md`（官方 `3c5b2276..fec97590`）。
盘点：`/tmp/sync318-ui-inventory.md` §Scope B。实现域：`packages/ui` 的 plugin-ui、v4 会话查找/正文、图片预览编辑，
以及 `packages/shared/mcp-apps` + `packages/desktop/src/main/pluginSandbox` 的最小接线。

## 1. 单一所有者与不变量

```text
plugin 资源 _meta.ui.backgroundRetention
  → pluginUiBridgeService.prepareSandbox（唯一登记入口）
  → Main pluginSandbox registry（resourceMeta 唯一 owner）
  → renderer Page.handle.resourceMeta
  → pluginUiPageRegistry.retention（窗口级保留/回收策略）
  → 原 page manager 30 任务 / 64 活页面准入（不修改）
```

- 保留/回收策略只增加“何时申请后台保留、何时回收”的判断；页面 owner 仍是 window-scoped page manager，
  `acquirePluginUiPage` 仍是唯一创建入口。不新建第二 runtime、frame host、accepted 队列。
- `backgroundRetention` 只认资源 `_meta.ui`（`normalizeMcpAppResourceMeta`）；工具 metadata 不授予。
- 嵌套 frame：只有 shell 主 frame 或插件 frame 自身（`zcode-sandbox:` 文档）的跨文档导航才是重载；
  子 frame（srcdoc / about:blank / frameDomains）导航不 dispose。层级判定在 Main（guestPolicy），
  renderer 只按 URL 兜底。安全边界（origin 白名单、popup 拒绝、webPreferences 硬化）不变。
- 会话查找只读 render unit / 已挂载 row；不写会话状态、不改 continuous/replayable 传输、不引入
  history/tail partition（B3c 单独切片）。
- 用户正文气泡是展示组合，不拥有消息/附件状态；正式消息与准备态共用同一组件。
- 图片编辑只拥有 transform + 标注历史；原图字节只读；附件入队唯一路径仍是
  `useComposerAttachments.addAttachmentFiles`；保存 PNG 追加到当前聚焦 Composer，不发送、不覆盖原图。
- 手机 #92：图片预览 pinch/drag/zoom/安全区/返回焦点、Composer 16px 输入与不抢焦点、会话布局全部保留。

## 2. 上游来源与取舍

| 项                                             | 上游                                                                                                                                                      | 本仓决定                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| B2 插件后台保留                                | `plugin-ui/app/pluginUiBackgroundRetention.ts`、page registry/plane/managed page                                                                          | 移植 retention 策略 + 嵌套 frame 判定                      |
| B2 display-mode / panel-tool / draft-retention | 3.18 同批                                                                                                                                                 | **不移植**（另一批 UI 能力）                               |
| B3a find index                                 | `v4/conversationFindIndex.ts`（builder + WeakMap 缓存）                                                                                                   | 移植；不引入 `ConversationTurnRenderUnitsPartition`        |
| B3b DOM 高亮/定位                              | `v4/conversationFindHighlightDom.ts`（按 row 收集 Range、`behavior:"auto"`）                                                                              | 移植                                                       |
| B3b 用户正文                                   | `v4/ConversationUserInputBubble.tsx`                                                                                                                      | 恢复独立组件；准备态同仓无 BotTopicPreparation，仅正式消息 |
| B1 图片编辑                                    | `image-preview-editor/*`、`hooks/useImageFilePreview.ts`、`lib/imagePreviewDownload.ts`、`lib/copyPreviewImage.ts`、`v4/ConversationImageFileMention.tsx` | 移植；Actions 去掉依赖 A3-full 的原生“打开方式”            |
| B4 Composer 编辑态                             | `composer-edit-mode/*` + lock 协议                                                                                                                        | **不实现**（无 CLI/协议支持，不伪造能力）                  |

## 3. 行为规则

### 3.1 插件后台保留（B2）

- 资源申请 `backgroundRetention: true` 的 MCP 页面在隐藏后保留在 inert 后台表面；缺省/`false` 页面
  沿用现有隐藏 5 分钟 / 容量回收。
- 窗口级后台声明页 > 4（软阈值）时，按最久未活跃优先回收 30 分钟未活跃且 `busy()`/running 为
  false 的页面；回收前 `claim` 预占，避免并发淘汰到 4 以下；无候选则等待下一次状态事件（不 0ms 重试）。
- 可见期、App/模型工具调用（busy 边沿）、sampling、`_meta["zcode/activity"] === true` 的工具结果
  更新活跃时间；空轮询、绘制、重复结果不续期。新工具结果（toolCallId/结果变化）可重新 `ensure`
  已回收页面；重复投影不复活。
- 窗口 `document.hidden` 变化：可见且存在可见锚点时恢复页面；隐藏时不累计闲置时间。
- 能力：`hostCapabilities.experimental["zcode/nestedFrames"] = {}`；旧宿主不宣告时插件自行降级。

### 3.2 会话查找与正文（B3）

- 查询归一化（trim + localeLowerCase）与匹配顺序/数量/active index 与现状一致；新增 builder 复用
  每 row 的文本/归一化缓存（WeakMap），流式只重建运行中 unit。
- 高亮：每个挂载 row 只遍历一次文本节点收集 Range（同一行多个命中复用），屏外行不查 DOM；
  定位用 `scrollIntoView({ block: "center", behavior: "auto" })`，不与虚拟测高补偿争夺滚动。
- 关闭查找/切换会话清除高亮；搜索跳转高亮仍是 3 秒后清理。
- 用户正文气泡：正文/渠道 mention/附件提示/尾注组合正确；无正文且无尾注不渲染空泡；正式消息与
  准备态复用同一组件，不复制消息或附件状态。
- 图片文件 mention 有预览上下文时点击走共享图片预览；非图片/无上下文保持普通 chip。

### 3.3 图片预览编辑（B1）

- 工具折叠在图片右侧「Draw」；工具 select/pen/text/rectangle/ellipse/arrow + 颜色 + undo/redo，
  无橡皮擦；选择后可拖动/Delete。
- 缩放 50–300%（按钮/滚轮/双指 pinch），拖拽只在超出视口时可 pan；resize 后仍有界并居中。
- 标注只在原图坐标系保存；`pointerup` 或 `lostpointercapture(buttons=0)` 一次性提交，真正 cancel 丢弃。
- 保存：自然尺寸 PNG，32M 像素上限，异步导出成功后同步捕获的 Composer 接收方一次性追加；不发送、
  不覆盖原图；失败保留可编辑历史并提示。
- 关闭/切图有未保存标注时 Add / Discard / Keep editing；保存中不允许关闭/切图。
- 下载保存原始字节；复制不含未保存标注（仅栅格化当前显示的原图）；CORS/剪贴板失败显式提示。
- 视频项保持播放控件，不出现标注工具；切图暂停旧视频。
- 手机 #92：pinch/pan/pointer capture 语义与现有 dialog 一致；`text-mobile-input-safe` 输入；安全区不回归。
- 打开方式/另存为消费 Scope A 已落地的 A3-lite `file-menu` 公开入口（`FileApplicationChoices` /
  `DefaultFileApplicationLabel`）：本机已安装编辑器 + 默认应用 + 另存为；Web 只保留浏览器下载，
  远程工作区不把路径交给本机应用。不做系统关联应用枚举（A3-full 后再切换泛型候选）。

## 4. 精确文件

新增：

- `packages/ui/src/plugin-ui/app/pluginUiBackgroundRetention.ts`
- `packages/ui/src/v4/ConversationUserInputBubble.tsx`
- `packages/ui/src/hooks/useImageFilePreview.ts`
- `packages/ui/src/lib/copyPreviewImage.ts`
- `packages/ui/src/lib/imagePreviewDownload.ts`
- `packages/ui/src/image-preview-editor/{CONTRACT.md,contract.ts,geometry.ts,annotations.tsx,composerTarget.ts,ImageEditorToolbar.tsx,ImagePreviewActions.tsx,ImagePreviewSurface.tsx,index.ts}`
- `packages/ui/src/v4/ConversationImageFileMention.tsx`
- `packages/ui/test/pluginUiBackgroundRetention.test.ts`
- `packages/ui/test/pluginUiNestedFrames.test.ts`
- `packages/ui/test/conversationFindIndex.test.ts`
- `packages/ui/test/imagePreviewEditor.test.ts`（纯 geometry/download/clipboard 逻辑）
- `packages/desktop/test/pluginSandboxSubframeNavigation.test.ts`

修改：

- `packages/ui/src/plugin-ui/adapters/pluginUiPageRegistry.ts`
- `packages/ui/src/plugin-ui/adapters/pluginUiPagePlane.ts`
- `packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts`
- `packages/ui/src/plugin-ui/app/pluginUiHostController.ts`、`pluginUiHostControllerContract.ts`、`pluginUiHostAppHandlers.ts`
- `packages/ui/src/plugin-ui/domain/buildPluginUiHostCapabilities.ts`
- `packages/ui/src/plugin-ui/CONTRACT.md`
- `packages/ui/src/components/ai-elements/image-preview-dialog.tsx`
- `packages/ui/src/previewPaneImageContent.tsx`（+ `PreviewPane.tsx`/`previewPaneContent.tsx` 仅传引用/下载源）
- `packages/ui/src/image-preview-editor/{ImagePreviewViewport.tsx,ImagePreviewEditorPanels.tsx,imagePreviewGestures.ts,useImagePreviewEditor.ts,useImagePreviewTransform.ts,saveEditedImage.ts}`
- `packages/ui/src/plugin-ui/adapters/{pluginUiPageRetention.ts,pluginUiPageHostContext.ts,pluginUiPageSnapshot.ts}`
- `packages/ui/src/v4/ConversationUserInputContent.tsx`、`ConversationRowView.tsx`
- `packages/ui/src/v4/composer/useComposerAttachments.ts`
- `packages/ui/src/v4/conversationFindIndex.ts`、`conversationFindHighlightDom.ts`、`useConversationTimelineFind.ts`
- `packages/shared/src/mcp-apps/{contract.ts,toolMeta.ts,CONTRACT.md,contract.example.ts}`
- `packages/shared/src/validation.ts`（仅 resourceMeta / 登记请求 schema 的 `backgroundRetention`）
- `packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts`（把资源声明的 `backgroundRetention` 传给登记）
- `packages/desktop/src/main/pluginSandbox/{registry.ts,guestPolicy.ts}`

共享文件（i18n locales、test-ids、architecture-policy.yaml、knip、root styles）由 U1/A 单写，本切片只交付
`/tmp/sync318-U2-shared-manifest.md` 的精确 key / test id / module 清单，不直接修改。

## 5. 语义验收

| Case  | 操作                                           | 期望                                                          |
| ----- | ---------------------------------------------- | ------------------------------------------------------------- |
| U2-01 | 资源声明 `backgroundRetention:true` 后隐藏页面 | guest 保留；可见/工具/sampling/`zcode/activity` 更新活跃时间  |
| U2-02 | 资源未声明或 false                             | 沿用 5 分钟/容量回收；不进入保留集合                          |
| U2-03 | 工具 metadata 只声明 backgroundRetention       | 不授予                                                        |
| U2-04 | 第 5 个后台声明页 + 最老页 30 分钟未活跃不忙   | 回收最老页；回收中日均名额不被并发占满；忙/审批中不回收       |
| U2-05 | 空轮询/重复结果/绘制                           | 不续期                                                        |
| U2-06 | 新工具结果到达已回收页                         | 同一 owner 重建；重复投影不复活                               |
| U2-07 | srcdoc/about:blank/frameDomains 子 frame 导航  | 不 dispose、不误报 crash；shell/插件 frame 自身导航仍 dispose |
| U2-08 | 旧宿主未宣告 nestedFrames                      | 插件降级；不创建即释放                                        |
| U2-09 | 同一查询逐字变化/长会话                        | 匹配与 active index 不变；每 row 只遍历一次；无 O(n\*m) 卡顿  |
| U2-10 | 查找定位                                       | 立即 auto 居中；关闭/切换会话清除高亮；搜索跳转 3 秒清理      |
| U2-11 | 用户正文组合（正文/仅附件/仅尾注/空）          | 组合正确；无空泡；准备态复用                                  |
| U2-12 | 图片 mention 有上下文                          | 点击打开共享预览；非图片保持 chip                             |
| U2-13 | 标注/缩放/pinch/保存                           | 原图不变；自然尺寸 PNG 追加一次；不发送；手机手势与安全区保持 |
| U2-14 | 未保存标注关闭/切图/导出失败/超 32M            | Add/Discard/Keep editing；失败保留历史；拒绝超限              |
| U2-15 | 下载/复制/加入对话/浏览器不支持                | 原始字节；复制不含标注；失败显式提示；无 Composer 时提示      |

## 6. 验证与未覆盖边界

执行：`pnpm typecheck`、`gate:lint`、`architecture:check --changed`、
`pnpm vitest run --config packages/ui/vitest.config.ts packages/ui/test/{pluginUiBackgroundRetention,pluginUiNestedFrames,conversationFindIndex,imagePreviewEditor}.test.ts`、
`pnpm vitest run --config packages/desktop/vitest.config.ts --exclude '**/.cache/**' packages/desktop/test/pluginSandboxSubframeNavigation.test.ts`、
`pnpm test:web-profile-mobile`。测试只使用临时 HOME/XDG/workspace 与 loopback。

DOM/React 渲染层（Range 高亮定位、气泡组合、完整标注面）当前仓库没有 jsdom/testing-library，
本切片以纯逻辑测试 + 真实 `packages/web` 手机/桌面 smoke 覆盖可执行部分；组件级浏览器断言仍需在
集成阶段用 Chromium fixture 补齐（见下方未覆盖边界）。

未覆盖/待后续：

- Main 侧 `pluginSandbox.setExecutionActive`（隐藏 guest 后台节流解除）需要 shared/preload/Main 新桥面，
  本切片未引入；retention 只保证页面不被回收，Electron 后台节流按现状。
- 图片“打开方式”使用 A3-lite（已安装编辑器 + 平台默认应用），不做系统关联应用枚举/图标。
- B4 Composer 编辑态需要 `lockQueueItemEdit` 协议与 CLI 支持，未实现。
- 真实 Chromium 组件断言（图片标注面板 390×844/1280×860、查找高亮定位、气泡长文本）需在集成阶段补齐；
  `pnpm test:web-profile-mobile`（真实 web 入口，390/320/1280/窄桌面 + Composer 焦点）已通过。
