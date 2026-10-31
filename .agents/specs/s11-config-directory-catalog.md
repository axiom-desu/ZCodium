# S11 / C3 非 tab 配置目录 catalog

## 产品规则与所有者

IProjectService.readProjects 是项目 roots 的唯一事实入口；Source 管理快照（servers/states/generation）和现有连接/Source settings attachment 是在线状态与服务归属的唯一事实。Catalog 仅为 React 只读派生，不存库、不读任务、不调用 prepareSession/mkdir/Agent、不创建 workspace/tab/conversation。保留既有侧栏插件预览及 ComposerMentionPrefill owner。

配置 target 不等于 WorkspaceTabState：携 hostId、sourceServerId、sourceConnection、workspacePath、workspaceIdentity、remoteSessionId、configOnline 与稳定 identity key。hostId 与 sourceServerId 是两种语义：hostId 只作 readProjects 的 exact 路由值，sourceServerId 只作 Source identity/attachment 归属，二者都不得从对方字符串切片猜测。本地 key 保留 path fallback；远端 identity 与 hostId 一律由 `@zcode/shared` 公开构造/解析入口产生（`remote:server:<sourceServerId>` / `remote:server:<sourceServerId>:<path>`），不手写第三格式，也不给 Host 加兼容别名。同路径不同 Source 必须隔离；同 Source 同路径的两个 legacy logical identity 仍是两个独立 context。项目全部 roots（包括未打开的）与已开 tabs 合并按 identity 去重。离线 Source 的已声明目录/保留 tab 显式禁用；legacy-single-root 项目显式只读，不伪装可操作。

remoteSessionId 是 logical scope，不是 Source scope：只能来自同 identity 的 tab 事实（按 identity 合并到同一 target）。不得把一个目录的 session 借给同 Source 的另一个目录，也不得把 legacy identity canonical 化成另一条 context。

## 接口与事件顺序

```text
Settings → base IProjectService.readProjects(local / canonical remote hostId)
         → Source management snapshot（servers/states/generation）
         → derived targets（sourceConnection 随 snapshot 更新，旧代不得发布）
用户选 target → 本地 base services
             → 同 identity 的既有 logical services（仅 exact identity 命中）
             → 否则真实 Source settings attachment（按 Source，不建 logical workspace/tab/task）
             → 原 pluginManagementService → 原 Host Agent runtime owner → config write
```

远端 hostId 使用 `@zcode/shared` 的 canonical `remote:server:<sourceServerId>`：由 `buildServerRemoteWorkspaceIdentity` + `remoteHostIdFromWorkspaceIdentity` 产生，需要校验时用 `buildRemoteHostWorkspaceIdentity` 解析。生产 Host `resolveProjectHostService` 只接受该形态，`server:<id>` 会 typed 失败（Invalid remote host identity）；UI 不得依赖 Host 接受第二格式，也不得在 Host 侧为旧形态加假别名。

枚举远端 roots 走 base Project 公共路由，不为枚举 admission attachment。只有显式选中在线远端 target、且没有 exact identity 的 logical attachment 时，才通过 IPlatformService.requestSourceSettingsAttachment 请求已有 Source settings 通道；绝不从 UI 引用 Repo/private registry/window.zcode。此 Desktop 配置入口不改变手机 replayable 链路，不启动手机 Agent/Host。

Source settings 服务注册表按 Source 连接代际判序（snapshot 的 state + updatedAt）：断线、重连换代或 Source 从快照消失时清除旧 proxy；跨代迟到的 admission 结果不得冒充当前代。失效后保留用户选择并展示只读说明，不 fallbackLocal、不用超时兜底。

读目录请求以 services + Source generation + request sequence 防迟到；服务解析以 target identity + current Source membership 校验。错误清空当前可操作投影，不沿用另一 Source/目标的数据。选择失效时保留只读目标说明，不静默变为本机 user 配置；离线/legacy 不挂载可写子组件。

插件配置继续传实际 target directory、identity 给既有服务。插件示例预填只调用真实 onCreateTask/Composer owner，携 targetWorkspace；不自动发送或安装。侧栏预览不替换。

## 验收（先测试后实现）

- 生产 PluginsSection + 临时 SQLite 的实际 createProjectService + 现有 Source settings 公共 bridge：不开 workspace tab/session，未打开 root 出现在 picker，选择后读取与配置走该 root，tab/task 仍为空，远端 metadata 不启动 Agent。
- 真实路由合同：`readProjects({hostId: "remote:server:<id>"})` 成功，`{hostId: "server:<id>"}` 必须 typed 失败；catalog 只发布 canonical hostId 才能让在线 Source 的声明目录保持可写。
- 同路径不同 Source 产生两个 identity，配置请求走不同 scoped service；已开 tab 与项目 root 只显示一次。
- A/B 两个不同目录互不借用 remoteSessionId；同 Source 同路径的两个 legacy logical context 保持两个独立 target，各自 logical services 只服务自己的 identity。
- 离线与 legacy target 展示明确 disabled 行，无 mutation / attachment admission。
- 同一 Source 断线/重连换代清除旧 Source settings proxy，重连后重新 admission；失效期间保留选择只读，不回落本地 user 配置。
- 延迟 A catalog/plugin 读后选择 B，再放行 A，B 内容/配置不被覆盖；A 的 pending attachment 晚到也只能登记 A。
- 配置失败不展示虚假成功；缺 Source settings 服务时展示不可操作状态而非回落本地。

## 执行入口（真实 CLI + CI）

本 catalog 的验收由 `scripts/ci/config-directory-catalog-smoke.mjs` 承担，且必须是**可执行入口**：

- 根 `package.json` 声明 `test:config-directory-catalog` = `node --import tsx scripts/ci/config-directory-catalog-smoke.mjs`
  （fixture 是 TS 且按 `.js` 说明符跨包导入真实 `@zcode/services` 源码，所以入口自带 TS loader）。
- `.github/workflows/desktop.yml` 的 `checks` job 在安装浏览器后真实执行 `pnpm test:config-directory-catalog`。
- fixture 侧文件只作为该入口的真实加载路径存在：`scripts/ci/fixtures/config-directory-host.ts` 由脚本
  `await import` 真实加载（生产 TaskIndexRepo/ProjectService/plugin seed），`src` 内联 fixture 经 Vite
  `build({input: "virtual:s11-config-directory.jsx"})` 编译后在 Chromium 里真实渲染。
- knip 只登记这类**有源码引用 + 执行证据**的入口，不用空 entry 或 ignore 消诊断。

## 迁移与范围

无 schema/数据迁移、新依赖、ignore 或基线调整。不修改 projectRootMetadata / SourceRegistry，不修改 HostIndex 手机段。MCP/skills/commands 保持已有配置服务链；目录配置 service 只能在 Settings 范围内提供，不能污染 conversation hook。
