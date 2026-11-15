# 上游 3.18 设置与文件表面（Scope A / U1）

来源：官方 `fec97590`（3.18.2），对照基准 `3c5b2276`（3.16.2）。

本文只覆盖 U1（Scope A）四项：个性化指令、设置搜索、文件另存/外部打开（A3-lite）、
文件树 HTML 单击与布局恢复。会话/图片/插件（Scope B）见 `upstream-3.18-sync.md`；
本切片不写 `image-preview-editor/`、`conversation-*`、`plugin-ui/`。

## 0. 所有权与不变量

| 事实              | 唯一所有者                                                           | 本切片的读法                                                                 |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 用户个性化指令    | 文件 `{HOME}/.zcodium/AGENTS.md`                                     | `ISettingService.getUserInstructions/saveUserInstructions` 是唯一读写端口    |
| 设置值 / 界面偏好 | `ISettingService`（本机 base Host）                                  | UI 只经 `useSettings()` 提交 patch                                           |
| 文件字节          | 文件所属 workspace Host 的 `IFileService`                            | 另存只用 `stat/readFileRange` 读取，`IPlatformService.saveFile` 唯一保存端口 |
| 本机应用打开      | `IPlatformService.getInstalledEditors/openInEditor/openExternalFile` | 远程 workspace 不把远端路径交给本机应用                                      |
| 设置搜索定位目标  | `SettingsPage` 的 `{ id: SettingsSearchId }`                         | `SettingsSearch` 只持查询草稿；`SettingsRow` 挂载后消费目标                  |
| 文件树目录/展开   | `useWorkspaceFileTreeData`                                           | `FileManagerPane` 只做布局与导航                                             |
| 面板开合偏好      | zustand `fileManagerNavigationOpenByWorkspace`                       | 空白 tab 的默认展开只是当前面板的临时覆盖                                    |

事件顺序（搜索定位）：

```text
输入查询 → SettingsSearch(本地草稿) → 选中(设置行) → onCloseAutoFocus → Section 导航
        → SettingsPage 写入 searchTarget → 目标分区挂载 → SettingsRow 消费 target
        → scrollIntoView(center) + focus({preventScroll}) → 2s 高亮(按 target 对象分轮次)
```

- 普通分类导航立即清空 `searchTarget`；旧高亮到期回调不得清除新轮次高亮。
- 搜索只读投影：不写设置值、不预挂载未选分区、不索引配置值与密钥。

事件顺序（另存 / 打开）：

```text
另存：菜单点击 → stat(前后核对 size/mtime) → 分块 readFileRange(≤50MiB)
    → platform.saveFile(data) → 成功/下载/取消 → 本地化提示（取消不是错误）
打开：菜单点击 → 本机？(canOpenLocalFiles && !remote) → getInstalledEditors / openExternalFile
    → 失败提示；远程只提供预览/另存
```

## 1. A1 个性化指令

- 位置：设置页「Agent 能力」分组第一项，位于「记忆」前；单层直达编辑器，无卡片包裹。
- 事实源：**本仓 CLI 读取的是 `{HOME}/.zcodium/AGENTS.md`**（`apps/zcode-cli/packages/adapters/src/context/index.ts`
  的 `findDefaultUserInstructionFile`），不是上游的 `~/.zcode/AGENTS.md`；服务与 UI 都按本仓路径解析，
  否则写了没人读。
- 上限：`USER_INSTRUCTIONS_MAX_BYTES = 100 KiB`（与 CLI `DEFAULT_MAX_BYTES` 一致），UTF-8 字节计。
  UI 显示 `x KB / 100 KB` 并禁用保存；服务层仍按共享常量拒绝，防止其他 RPC 调用方绕过。
- 写入：`atomicWriteText(..., { useFileLock: true, fileMode: 0o600 })`（复用现有原子写 + 跨进程锁，
  目录创建在取锁之前）；文件权限只会收紧到 0600。
- 状态 owner：`PersonalizationSection` 模块级 zustand store。
  - `generation` 绑定 `settingService` 实例：Host/连接切换后旧读取/保存回调失效。
  - `loadRequestId` 绑定每次读取；`beginSave` 递增它，使晚到的读取不得覆盖已保存基线。
  - 卸载不失活：保存中切走分区，草稿与失败态保留，可重进重试。
- 读取：`ENOENT` → 空串基线（不创建文件）；其他错误 → 失败 + 重试，且不得把空串当基线放行保存。
- 「文件优先」：读取时若文件内容 ≠ 基线（外部改动）则覆盖草稿；若文件仍等于基线则续用未保存草稿。
- Web/手机（非桌面本地入口）：只显示「前往本地桌面端设置」指引，不挂服务、不发起读写。
- 保存成功提示「已保存，新会话生效」；Ctrl/Cmd+S 等价保存并阻止浏览器保存网页。

## 2. A2 设置项搜索与定位

- 入口：设置页侧栏顶部。宽侧栏显示文字，窄栏/手机只显示搜索图标；不新增 `/remote` 设置入口。
- 匹配：`settingsNavigationSearchKeys`（NFKC + 小写 + 去空白；中文追加全拼与首字母）+
  `matchesSettingsNavigation`（顺序字符包含）。说明文字只做子串匹配，且排在名称匹配之后。
- 索引：只登记本仓当前可见的固定设置行（`searchId` = 翻译 key）。不登记已移除的
  `mobilePush`/`dataSync`/`shares`/`projects`/`archives`/付费与 coding plan 行；本仓没有
  `agentBehavior` 分区，相关行按现有 `general` 登记。
- 可见性：沿用现有投影（`isSettingsSectionAvailable`、`resolveDynamicWorkflowModeSettingView`、
  `resolveComputerUseAvailability`），不新增缓存或网络请求。
- 定位：目标行 `scrollIntoView({block:"center"})` + `focus({preventScroll:true})` + 约 2 秒高亮；
  高亮按目标对象分轮次；普通分类导航立即清空目标。
- Escape：查询非空先清空；空查询再关闭；输入法组字（`isComposing`）不处理。
- 键位：搜索只读现有翻译 key 与稳定 `searchId`。

## 3. A3-lite 文件另存 / 外部打开

- 复用现有平台端口，**不移植**上游 `getFileApplications`/`openFileWithApplication` 的原生枚举与图标。
- `FileApplicationChoices` 对 `{ id, name, iconDataUrl?, isDefault? }` 泛型；A3-lite 传 `EditorInfo[]`。
  前 3 项直接可见，其余进「更多打开方式」子菜单；无候选时给中性系统动作/加载态。
- 另存（`fileCopy.ts`）：`stat` 前校验 → 0 字节允许 → `> 50 MiB` 拒绝（读取前）→ 1 MiB 分块
  `readFileRange` → 写后再次 `stat` 比对 `size`/`mtimeMs` → 交给 `platform.saveFile`。
  - 取消：`canceled` 不是错误，不提示已保存。
  - Web：`saveFile` 触发浏览器下载，提示「下载已开始」（不产生本地路径）。
  - 远程：字节来自 workspace Host；不提供本机应用打开。
- 入口：文件树行右键、消息内文件链接右键、`OpenSplitButton` 下拉。打开方式与另存共用同一份
  `file-menu` 组件，不复制第二份菜单。
- 候选解析仍由各入口原有的单一路径完成（`resolveWorkspaceEditorSelection` + `EditorInfo[]`），
  `file-menu` 只负责菜单渲染，所以本切片**不新增** `useFileApplications.ts` 适配器/第二套查询；
  以后接系统关联应用时再补该适配层并把 `isDefault` 填进泛型候选。
- 失败一律本地化提示，不用 shell 拼接路径。

## 4. A4 文件树 HTML 单击 + 布局恢复

- 新设置 `AppSettings.fileTreeHtmlClickOpensBrowser?: boolean`（默认 false，patch 可选）。
- 归属：本机 base Host 设置；设置页在远端 workspace 激活时也读写本机（`useBaseWorkspaceServices`）。
- 文件树（`WorkspaceFileTree`）读同一份设置，把 `htmlClickOpensBrowser` 与 `workspaceRemoteSessionId`
  传给行；远程 workspace 与无本机浏览器的平台（Web/手机）不把远端路径交给本机浏览器。
- 行语义：开关开启且本地 `.html` → 单击走现有内置浏览器 URL；右键「打开」始终源码预览。
- 设置分组仅在桌面且存在本机内置浏览器时出现。
- 布局恢复（只移植宽度恢复，保留本仓 `preview,directory` 顺序与 header）：
  容器宽度曾 < 80px 导致两栏都被折叠到 0 时，宽度恢复到 ≥160px 且两栏百分比仍为 0 →
  递增 `layoutEpoch` 重挂载 `ResizablePanelGroup`，按默认/已存布局重新测量；重挂载后重新应用显隐。
  判定逻辑抽成纯函数 `shouldResetFileManagerLayout` 以便单测（容器 ≥160px 且两栏百分比都为 0）。
- 空白文件 tab：沿用现有 `resolveFileManagerNavigationOpen`（无 workspace 偏好时默认展开）。
  **不**另加“空白 tab 覆盖已存偏好”的层：`scripts/ci/file-manager-navigation-smoke.mjs` 已固定
  “刷新后恢复持久化偏好”，覆盖会让 reload 后把用户收起的目录重新展开。A4-07 的“不改历史偏好”
  由此保持；只保留 A4-06 的宽度恢复。
- 不移植上游 3.18 的 directory/preview 换序与 header 改动（`file-manager-navigation-pane.md` + 手机 #92 已定）。

## 5. 文件清单

新增：

- `packages/shared/src/userInstructions.ts`
- `packages/ui/src/settings/PersonalizationSection.tsx`
- `packages/ui/src/settings/FileTreeHtmlOpenSetting.tsx`
- `packages/ui/src/settings-search/{CONTRACT.md,contract.ts,contract.example.ts,module.ts,index.ts,SettingsSearch.tsx,SettingsSearchTarget.tsx,settingsNavigationSearch.ts,settingsSearchIndex.ts}`
- `packages/ui/src/file-menu/{CONTRACT.md,contract.ts,contract.example.ts,module.ts,index.ts,FileApplicationChoices.tsx,FileApplicationSubmenu.tsx,FileApplicationIcon.tsx,DefaultFileApplicationLabel.tsx,FileSaveAsMenuItem.tsx,fileCopy.ts,fileApplicationSubmenu.css}`
- `packages/ui/test/personalizationSection.test.tsx`、`packages/ui/test/settingsSearch.test.tsx`、
  `packages/ui/test/fileMenu.test.tsx`、`packages/ui/test/fileTreeHtmlOpenSetting.test.ts`
- `packages/services/test/settingServiceUserInstructions.test.ts`

修改：

- `packages/shared/src/index.ts`、`packages/shared/src/test-ids.ts`、`packages/shared/src/protocol.ts`、
  `packages/shared/src/validationAppSettings.ts`、`packages/shared/src/platform.ts`
- `packages/services/src/paths.ts`、`packages/services/src/setting/setting.ts`、
  `packages/services/src/setting/settingService.ts`、`packages/services/src/fs/atomicFileUtils.ts`（可选 `fileMode`）
- `packages/ui/src/SettingsPage.tsx`、`packages/ui/src/settings/settingsPageConfig.ts`、
  `packages/ui/src/lib/settingsNavigation.ts`、`packages/ui/src/settings/SettingsPageParts.tsx`、
  `packages/ui/src/settingsPageHelpers.tsx`、`packages/ui/src/settingsCodePreview.tsx`、
  `packages/ui/src/settings/BrowserSettingsSection.tsx`、`packages/ui/src/settings/ComputerUseSection.tsx`、
  `packages/ui/src/settings/ProactiveSuggestionsSetting.tsx`、
  `packages/ui/src/settings/PluginAutoRecommendationSetting.tsx`、
  `packages/ui/src/settings/DynamicWorkflowModeSetting.tsx`、
  `packages/ui/src/settings/MemorySettingsSection.tsx`
- `packages/ui/src/OpenSplitButton.tsx`、`packages/ui/src/components/ai-elements/message.tsx`
- `packages/ui/src/workspace-file-tree/{WorkspaceFileTree.tsx,WorkspaceFileTreeRowView.tsx,WorkspaceFileTreeList.tsx,WorkspaceFileTreeStickyFolders.tsx,helpers.ts,types.ts}`
  （`helpers.ts` 新增 `shouldOpenWorkspaceFileTreeHtmlInBrowser`、`shouldResetFileManagerLayout`）
- `packages/ui/src/WorkspaceFileTree.tsx`（只加 `layoutEpoch` 与空白 tab 覆盖）
- `packages/desktop/src/renderer/src/desktopPlatform.ts`（`canOpenLocalFiles: true`）、
  `packages/web/src/platform/index.ts`（`canOpenLocalFiles: false`）
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`、`packages/ui/src/styles.css`（`compact-web` variant）

不写：`architecture-policy.yaml`（由主代理统一登记）、`WorkspaceShellLayout`、`DesktopWindowFrame` 重写。

## 6. 验收与测试映射

| Case              | 自动化                                                           | 说明                                                                |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| A1-01/03/04/05/08 | `personalizationSection.test.tsx`（store 纯逻辑）                | 空文件基线、取消恢复基线、Ctrl+S 门控、字节上限、读取失败不放行保存 |
| A1-02/06/07/09    | `settingServiceUserInstructions.test.ts`（临时 HOME）            | 原子创建/覆盖、超限错误码、ENOENT 空基线、generation/requestId 失效 |
| A1-10/11          | 组件分支（非桌面直接返回指引）+ `pnpm test:web-profile-mobile`   | 非桌面不挂服务                                                      |
| A2-01/02/03/08    | `settingsSearch.test.tsx`（纯函数 + 索引一致性）                 | 中文/全拼/首字母/大小写/全角、说明排序、可见性裁剪、空态            |
| A2-04/05/06/07    | `SettingsSearchTarget` 逻辑单测 + 真实浏览器 smoke               | 定位/计时/再次命中/Escape                                           |
| A2-10             | `pnpm test:web-profile-mobile` + 320/390/1280 smoke              | 无横向溢出                                                          |
| A3-02/03/04/05    | `fileMenu.test.tsx`（`readFileCopy` 用注入 source）              | 0 字节、>50MiB 拒绝、size/mtime 变化、取消                          |
| A3-06/07/09       | 同上（`saveFile` 注入）+ 平台能力分支                            | 下载提示、远程不交本机应用、迟到结果不覆盖                          |
| A4-02/03/04       | `fileTreeHtmlOpenSetting.test.ts`（单击决策纯函数）              | 单击浏览器 / 右键预览 / 远程不交本机                                |
| A4-01/05          | 组件分支 `FileTreeHtmlOpenSetting`                               | 只读写 base Host；无本机浏览器不显示                                |
| A4-06/07          | `FileManagerPane` 布局逻辑 + `pnpm test:file-manager-navigation` | 两栏 0 → 恢复；空白 tab 默认展开                                    |

真实浏览器（临时 HOME/XDG/loopback）只覆盖入口可达与无横向溢出；不写真实用户数据。

## 7. 与上游的刻意差异

1. 个性化文件路径用本仓 CLI 实际读取的 `{HOME}/.zcodium/AGENTS.md`（上游 `~/.zcode/AGENTS.md`）。
2. 设置搜索不引入 `agentBehavior`/`shares`/`dataSync`/`archives` 分区与已移除行。
3. 打开方式用 `EditorInfo[]` + `openExternalFile`（A3-lite），不移植原生关联应用枚举。
4. `compact-web` 仅用于搜索入口与 `SettingsRow` 窄屏换行，不整体搬设置页横向导航重排。
5. 根 `WorkspaceFileTree.tsx` 只取 `layoutEpoch`（宽度恢复），保留本仓 panel 顺序/header。
6. 空白 tab 不覆盖已存目录偏好：既有 `file-manager-navigation` CI 已固定“刷新后恢复持久化偏好”，
   覆盖会让用户收起的目录在 reload 后重新展开；A4-07 只保留“无偏好时默认展开”。
7. A3-lite 不新增 `useFileApplications.ts`：候选解析仍由各入口既有单一路径完成。
8. 保留本仓现有测试与门禁；不跟随上游删除包级单测。

不恢复：遥测/归因、登录/账号、off-peak、highspeed/request-auth 分叉、CUA 休眠帧、云同步/分享/支付。
不改 Desktop continuous 与手机 replayable 协议、队列、快照、lease、stale-run 语义。
