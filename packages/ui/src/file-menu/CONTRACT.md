# 文件菜单

文件菜单展示「打开方式」候选并导出当前文件的原始副本。目录沿用调用方原来的编辑器菜单。

- 只使用本机平台能力打开本机真实文件；远程工作区不把路径交给本机应用。
- 候选列表属于当前目标和当次查询；切换路径或卸载后旧结果失效（调用方按目标作 key）。
- 保存由所属 workspace Host 的 `stat/readFileRange` 读取，最多 50 MiB。读取前后核对尺寸和修改时间，不做文本解码。
- `IPlatformService.saveFile` 是唯一保存端口。先完成读取再打开保存对话框，允许用户选择源路径；取消是正常结果。
- UI 只维护查询和按钮忙碌状态，不持有 task/session/stream 状态。
- A3-lite：候选形状是 `EditorInfo` 子集（`{ id, name, iconDataUrl?, isDefault? }`），
  不新增原生关联应用枚举；`FileApplicationChoices` 对候选泛型。
