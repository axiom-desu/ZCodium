# R2：公开准备入口到 Host 的 R3 制品闭包

父规格：remote-first-connect-usability / upstream-3.16-source-server。

## 规则与边界

- `packages/zcode-server-cli/src/packaging/stage.ts::stageRelease` 是唯一 archive 组装 owner。scripts 只准备既有参数、生成 shared schema 的 descriptor、核验并复制字节，不另写安装器或 legacy deploy 路径。
- 默认 prepare 保留既有组件产物供现存静态消费方使用，但这些不是 Source 安装源；bundle 成功必须有非空 R3 descriptor 及每个 target 的完整 archive。旧组件 manifest 不能独立造成成功。
- `prepare-prebuilds.mjs --source-server-config <json>` 接受已准备好的 stage 参数（Node、Server dist、Agent、技能、插件、工具、声明、依赖路径），执行同一 R3 包装步骤，支持隔离/离线准备；不接受用户编写的 descriptor，不下载其它 target。默认流程准备 linux-x64，复用现有已校验 Node/工具/Agent，再调用同一步骤。
- 默认 prepare 开始时调用既有 `writeBuildMetadata()` 刷新当前检出的 Desktop 构建元数据，避免旧 `out/metadata` 污染；CLI 沿既有 rolling-app-version 同源注入，不新增版本 env owner。stage 后使用宿主 Node 实际运行 staging 的 CLI `--version --json`，同时验证 external 依赖闭包及版本（不能要求仓库外 dist 预先安装第二套 node_modules），必须等于指定版本；目标 Node 必须存在且非空，工具、插件、技能缺失均失败。hash、size、target、严格版本、路径边界不放宽。
- descriptor 在所有 archive stage/验证成功后原子提交。重建开始撤销旧 descriptor；bundle 失败撤销输出发布标记。不能生成空资产假成功。
- `bundle-remote-assets.mjs --config <json>` 复用公开 `bundleRemoteAssets` 参数，允许隔离输出；`verify <directory> <version>` 使用同一严格验证，不要求测试改仓库目录。
- bundle 输出 `<bundledRemoteAssetsDir>/releases/<version>/{source-server-release.json,zcode-server-<target>.tar.gz}`。归档原字节复制，保持 POSIX 执行权限；路径只用 `node:path`，归档及 schema 中路径遵循现有 R3 规则。

## 所有者与事件顺序

```text
prepare（静态输入） → stageRelease（唯一 archive owner）
 → 核验 CLI 版本/完整资产 → descriptor 原子提交
 → bundle 校验 schema/version/每个 archive size+sha+containment → 原字节复制 → descriptor 最后提交
 → Main 已有 bundledRemoteAssetsDir → Host resolver runtime options
 → 既有 resolveSourceServerReleaseAsset → target/version/size/hash 严格校验
 → 用户确认后的原 transport installer → 原 daemon/registry owner
```

- Main 初始化窗口 Local Host 时通过 `InitLocal.remoteAssets`（复用 shared `remoteAssetDirsSchema`，可选以保持旧消息兼容）传同一 `resolveRemoteAssetDirs()` 结果。Host 管理服务 connect/update 闭包及常规 ConnectRemoteWorkspace 均消费这个静态配置，不另存 source 业务状态。
- Host 显式 release-dir override 仍优先；其次消费 Main 注入的 bundledRemoteAssetsDir，再保留工作区开发候选。无描述符/目标/制品时明确失败，不静默用旧部署器、不引入第二 source authority。
- 生命周期/连接业务状态仍由 window registry 持有；本片无 accepted queue、scope、lease、generation、desktop continuous 或 mobile replayable 改动。

## 验收

- 先红：公开 prepare config → 真实 tar archive → bundle → 从不同 cwd 的 Host options/resolver 成功，无手工 descriptor。
- 缺 Node/Agent/工具/插件、空 targets、版本不符、损坏 archive、重复/未知 target、路径逃逸、失败重建旧 marker 均拒绝。
- 现存 bundle/offline 目标测试继续执行；本机 target 用真实 fresh CLI bundle、Node、Agent、依赖闭包在临时目录准备/安装/启动。fixture 测试不冒充真实运行成功；远程平台无环境只报告路径覆盖。
- 必须执行 typecheck、lint、architecture、目标测试和改动格式检查；真实 SSH/WSL/Docker 未连接。

## 闭包缺陷修复（已完成，packaging owner）

`stageRelease.copyDirectoryIfPresent` 过去只接受 `*-plugin` 目录，静默丢弃 shared 注册表中的
`node-repl-host`；组件路径又统一拼 `-plugin` 后缀，进一步写错目录名；通用复制还过滤
`dist/mcp/node_modules`，把已按 CUA 白名单准备好的固定 runtime 一起丢掉。

修复规则（唯一 owner 仍是 packaging）：

- 候选目录改为 shared `BUILTIN_PLUGIN_ASSETS` 的完整目录名集合，不再按后缀猜；
  组件路径与 manifest 拆分：组件用真实目录名，`manifest.plugins` 继续沿用去 `-plugin` 的既有标识。
- 仅 `node-repl-host` 允许穿越 `node_modules` 边界，且只放行 `cuaRuntimeRequiredPaths`
  推导出的四个包目录（含作用域祖先目录）；其它插件、其它包与嵌套 `node_modules` 仍被拒绝。
- CUA 复制后按同一 `cuaRuntimeRequiredPaths` 逐文件复核，缺一个即失败，不发布半套运行时。
- 复制目标平台由发行 target 窄化（`cuaTargetOf`），不再默认使用构建机平台。

回归：`packages/zcode-server-cli/test/packagingRelease.test.ts` 新增两项——node-repl-host
闭包与组件路径正确、非白名单 `node_modules` 缺席；缺 CUA 文件时 fail closed。

## 实际验证（Node 24.14.0）

- `node --test scripts/ci/source-server-assets.test.mjs scripts/ci/bundled-remote-assets.test.mjs
scripts/ci/bundled-remote-source.test.mjs`：18 passed / 0 failed（此前唯一的打包闭包失败已转绿）。
- `vitest run packages/zcode-server-cli/test`：40 passed。
- `node scripts/ci/source-server-first-connect-smoke.mjs`（真实 fresh 构建 + 真实插件/Node/Agent）：
  见 `remote-first-connect-usability.md` 的端到端记录。
- root `pnpm typecheck` 通过、`pnpm lint` 0/0、`pnpm architecture:check --changed` 0 violation。
- 未覆盖：真实 SSH/WSL/Docker 目标；Agent 首条模型消息；Windows/macOS 目标制品。
