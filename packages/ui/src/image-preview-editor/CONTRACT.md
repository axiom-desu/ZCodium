# image-preview-editor

图片预览编辑的展示层：缩放/平移、标注历史与“加入对话”动作。公开入口 `index.ts`。

## 所有权

- 唯一可变状态：`ImagePreviewSurface` 的缩放 transform 与标注历史（undo/redo）。
- 原图字节只读；导出时只栅格化原图 + 当前标注，不截图、不写回原图。
- 附件入队唯一路径是调用方 Composer 的 `addAttachmentFiles`。`composerTarget.ts` 只用一次性
  同步事件捕获当前聚焦的接收方；导出异步完成后不再重新查找，避免追加到切换后的会话。
- 关闭/切图是“离开请求”：surface 只通过 `onNavigationGuardChange` 注册守卫，是否显示
  Add/Discard/Keep editing 由 surface 自己持有；dialog 不复制编辑状态。

## 行为

- 缩放 50–300%（按钮/滚轮/双指 pinch）；只有超出视口时可 pan；resize 后仍居中且有界。
- 工具：select / pen / text / rectangle / ellipse / arrow + 颜色 + undo/redo；无橡皮擦。
- 标注坐标存原图像素；`pointerup` 或 `lostpointercapture(buttons=0)` 一次性提交，cancel 丢弃。
- 保存：自然尺寸 PNG，源像素上限 32M；`target.append(file)` 拒绝时提示且保留历史。
- 视频不进入编辑；下载保存原始字节，复制只栅格化当前显示的原图。
- 手机：`touch-none` + pointer capture 由 surface 独占，输入框使用 `text-mobile-input-safe`。

## 打开方式与另存为

`ImagePreviewActions` 消费 Scope A 的 `file-menu` 公开入口（A3-lite）：本机已安装编辑器候选 +
平台默认应用（`openExternalFile`）+ 另存为。只有 `canOpenLocalFiles` 的平台显示“保存并打开”；
Web 只保留浏览器下载；远程工作区不把远端路径交给本机应用。不做系统关联应用枚举/图标（A3-full
以后再切换 `FileApplicationInfo`，公开 props 保持泛型兼容）。
