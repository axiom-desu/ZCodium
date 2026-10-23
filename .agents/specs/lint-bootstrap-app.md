# bootstrap/app max-lines 分片：createApp 装配接缝与状态 owner

本 spec 是 `.agents/specs/lint-debt-retirement.md` 的实施分片 5（bootstrap app）实现说明，
只覆盖 `apps/zcode-cli/packages/bootstrap/src` 下 6 个 max-lines 文件及其相邻 helper/test。
不改 `app/official-plugin-definitions.ts`（官方 min-asset 已单独更新）、其它 `zcode-protocol*`
目录、contracts/Rust/gate/baseline 或 spec 总文。

## 范围

| 文件                                          | 原有效行 | 目标 | 新文件（同包）                                                                                                                                                                    |
| --------------------------------------------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugins.ts`                              | 1274     | ≤400 | `plugin-types.ts`, `plugin-context.ts`, `plugin-marketplace-declaration.ts`, `plugin-marketplace-actions.ts`, `plugin-install-actions.ts`, `plugin-data.ts`, `plugin-overview.ts` |
| `src/app/types.ts`                            | 645      | ≤400 | `types-app-surface.ts`, `types-app-workflow-surface.ts`, `types-app-command-surface.ts`, `types-app-workspace-hook-surface.ts`                                                    |
| `src/app/create-app.ts`                       | 1114     | ≤400 | `create-app-dependencies.ts`, `create-app-runtime.ts`, `create-app-app-surface.ts`, `create-app-prompt-attachments.ts`                                                            |
| `src/app/session-facade.ts`                   | 820      | ≤400 | `session-facade-types.ts`, `session-facade-query.ts`, `session-facade-command.ts`, `session-facade-close.ts`, `session-facade-model-command.ts`                                   |
| `src/app/bundled-plugins.ts`                  | 573      | ≤400 | `bundled-plugin-seed-source.ts`, `bundled-plugin-seed-cache.ts`                                                                                                                   |
| `src/app/workspace-hook-review-controller.ts` | 454      | ≤400 | `workspace-hook-review-mutation-runner.ts`                                                                                                                                        |

新增文件同样受 400 有效行约束；不压行、不新增 disable/ignore/阈值。

## 接缝与状态 owner

### createApp

`createZCodeApp` 仍是唯一入口和唯一 App 生命周期 owner，但按**固定顺序**调用：

1. `resolveAppDependencies`（`create-app-dependencies.ts`）：配置、日志、startup timer、storage、
   session store、runtime config、permission、artifact/execution/mcp/fs/http/… 端口与 plugin
   catalog。只构造依赖，不创建 AgentRuntime，不组装公开 API。
2. `createAppRuntime`（`create-app-runtime.ts`）：workflow 子装配、journal/run service、
   `AgentRuntime`、startup marks、input/workflow/session facade。它是 runtime 引用与
   `resumePrepared` 的唯一 owner，返回类型化的 getter/窄端口。
3. `createAppSurface`（`create-app-app-surface.ts` + `create-app-prompt-attachments.ts`）：
   按原顺序展开 session/workflow/script/plugin facade 与可选 dwf 读面，返回 `ZCodeApp`。

约束：

- 原 async IO 顺序（config → subagent profiles → plugin outcome → skill roots → session store →
  runtime config → broker → runtime → facade → runtime manifest）逐字保持；helper 只做顺序调用，
  不自作初始化。
- 第二份 runtime/session/persistence 事实不出现：`runtime`、`resumePrepared`、`closePromise`
  仍只在原 owner（runtime 构造器/session facade）内。
- 进程 root main 不承载 session/queue 业务；drawf run 的队列/持久化仍归 run service 与
  session store。
- 新 helper 使用显式 typed port，不用 `any`/mixin/隐式 `this`；可选能力以窄接口 + 存在性守卫
  表达，不伪造空实现。

### types.ts

纯类型划分：`ZCodeApp` 变为 `interface ZCodeApp extends ZCodeAppQuerySurface,
ZCodeAppWorkflowSurface, ZCodeAppCommandSurface, ZCodeAppWorkspaceHookSurface`。
方法签名、可选性、文档与 receiver 不变；`types.ts` 继续导出 `ZCodeApp` 及原 options/结果类型。

### session-facade

- 查询面（read target/todos/transcript/models/mcp 读面/checkpoints/sample）与命令面
  （setMode/setModel/setThoughtLevel/setLocale/target 写/mcp 写）分开组装，最终
  `createSessionFacade` 仍返回原 `SessionFacade` 全量成员。
- `close` 的 singleflight、资源关闭顺序、6s deadline、错误优先级保持在 close owner。
- app-provided tool 名称镜像、`currentLocale` 等会话局部状态只保留一份，通过 typed context
  在 query/command 构造器间传递，不复制。

### plugins

- 三个 scope（user/workspace/default）的 enable/install/readiness 唯一 owner 仍是 config
  文件写入函数（`updatePluginEnabledInFileConfig` 等）与 adapter 的 installed records；
  bootstrap 只投影，不新增第二份状态。
- 原 `plugins.ts` 公开 export 保持：新文件实现，`plugins.ts` 重新导出；跨包仍只走 index 公开入口。
- marketplace 声明/刷新/安装/卸载顺序、storage lock 边界、restore 核心的无锁语义不变。

### bundled-plugins

- seed source（filesystem/SEA 递归枚举、required paths、hash）与 cache 事务（marker、backup、
  atomic replace、degraded fallback）分文件；`seedBundledOfficialPlugins` 原循环顺序与锁预算不变。
- `includedTopLevelPaths`、`walkPluginSeedFiles` 递归与 `runtimeTopLevelPaths`/`runtimeSubtrees`
  语义不变；新增 skill helper 不得因白名单或目录裁剪丢失。缓存/catalog 仍为不可变产品资产。

### workspace-hook-review-controller

- controller 仍是 review flow registry、generation、mutation queue、supervisor 的唯一 owner。
- 只把无状态 helper（mutation 串行执行/持久信任写入/admission 重发）移到
  `workspace-hook-review-mutation-runner.ts`；事件顺序与 supervisor 时机不变。

## 测试先行

新增 `test/lint-bootstrap-app.test.ts`：

- `createZCodeApp` 入口面：缺 providerRegistry 同步拒绝；返回对象含 session/runtime/核心读面；
  可选 dwf 能力缺席时不注册，存在时注册。
- 初始化调用次序：注入 logger/startup 记录，验证 config→profiles→plugins→runtime→facade 的
  顺序与 runtime 构造只发生一次。
- 失败分支：runtime 构造失败时 provider model runtime 与自有 broker 被清理，原错误优先抛出。
- types 组合面与 session facade 键集在编译期/运行期锁定。

## 验收

- 先跑新增测试（在原文件上通过），再实施拆分后重跑。
- `pnpm --filter @zcode/bootstrap typecheck`、`pnpm --filter @zcode/bootstrap test`。
- 定向 oxlint 6 个原文件与新 helper：max-lines 归零、无新增 warning；清理本切片 warning
  （bundled-plugins 的 spread 空 fallback 与 regex 前缀、plugins 的未用 workingDirectory）。
- 根 typecheck/lint/三 gate/architecture 由父任务统一验收；本切片不刷新 baseline。
