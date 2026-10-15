# ZCodium Rust：按产品口味默认启用 Rust CLI

## 规则（实现前确定）

- 用户明确授权 **打包的 ZCodium Rust（preview flavor）默认使用 Rust CLI**；ZCodium Exp（production flavor）及未打包开发态默认 TS。产品 flavor 来自已有构建期 `ZCODE_PRODUCT_FLAVOR`，不按可执行文件存在、app 名字符串或运行时 shell 的 `ZCODE_PREVIEW_IDENTITY` 猜测。
- 保留优先级：custom `ZCODE_AGENT_SERVER_COMMAND` > 非空显式 `ZCODE_AGENT_SERVER_RUNTIME` > 产品默认。显式 `ts` 可覆盖 Rust 包默认值；未知显式值传给既有 Services resolver 并明确失败，不能被默认值吞掉。空/纯空白视为未覆盖。
- Desktop Main 是产品默认策略的唯一 owner，在既有 `buildHostProcessEnv` 注入有效 runtime。Services 继续只按该值解析命令；不把 desktop flavor 引入通用 Services/server、不新增 runtime 状态或第二条 Agent 启动链。
- 默认 Rust 与显式 Rust 都复用既有 fail-closed 分支：缺 binary 报错，绝不自动转 TS。旧 workspace owner/lease、存储握手、stdio、desktop continuous 与 web replayable 边界不变。
- Rust 资产准备与 electron-builder extraResources 必须跟同一个**有效产品 flavor**走。`ZCODE_ENV=test` 也可能解析成 preview / ZCodium Rust，不能仅检查 `ZCODE_PREVIEW_IDENTITY=1` 而漏掉 binary。production flavor 不因磁盘残留 Rust 资产而打包/启用。
- 不改默认存储路径、不迁移或访问用户库。本切片只改默认选择与打包一致性，不承诺先前未验收的历史库/扩展能力已通过。

## 顺序与接口

```text
构建：effective provider environment + preview flag
        → resolveDesktopProductFlavor / identity
        ├─ 资产准备 / packaging：preview 含 resources/rust
        └─ tsup define：ZCODE_PRODUCT_FLAVOR

运行：Main buildHostProcessEnv（isPackaged + compiled flavor + merged env）
        → Host env.ZCODE_AGENT_SERVER_RUNTIME
        → 既有 Services resolver（custom优先 / runtime fail-closed）
        → 既有 storage preparation → Agent stdio → Core owner
Desktop continuous / Web replayable 的 session owner 与 seq 规则保持不变
```

## 必测场景

1. packaged preview 无 override → Rust；同一结果不受 backend test/production 区别影响。
2. packaged production、未打包 preview/production → TS 默认。
3. 显式 ts、Rust、未知值不被默认覆盖；空白值按默认；custom command 仍最高优先级。
4. Main 实际 buildHostProcessEnv 的本地 env / process.env 合并与默认注入，经隔离mock测试；不能只测未接线纯helper。
5. Main 生成的默认 Rust env 交给真实 Services resolver，缺 binary fail-closed（测试临时目录/fixture，无真实runtime）。
6. 资产矩阵：production+flag0→不含Rust，production+flag1→含Rust，test+flag0/1→preview含Rust；prepare与packaging/tsup身份来源一致。
7. 只执行无窗口的单测/静态检查，不启动 GUI、不打完整安装包、不运行性能测试。类型检查、lint、architecture、定向测试/格式检查如实记录。真实安装包验证留给用户。

## 本轮实际实现与验证

- Main 的 `desktopAgentRuntimeEnv.ts` 负责纯默认决策，`buildHostProcessEnv` 完成真实注入；不修改通用 Services resolver。
- `runtime-assets-plan.mjs` 复用已有身份函数，prepare 与 electron-builder 按有效 flavor 准备/包含 Rust。省略显式配置 environment 时保留输入 env，不能把 production 擦成 undefined。
- 新 Main vitest 已加入 `.github/workflows/desktop.yml` 的既有 Vitest 门禁；资产矩阵测试由现有 `scripts/ci/*.test.mjs` 门禁自动纳入。
- `pnpm vitest run packages/desktop/src/main/desktopAgentRuntimeEnv.test.ts packages/desktop/src/host/storagePreparationProcesses.test.ts`：39/39（默认策略新增 15，既有 storage 24）。
- `node --test --test-isolation=none scripts/ci/*.test.mjs`：277/277（新增资产选择/环境矩阵 13 项，包含 stub prepare 实际命令及真实 builder 配置加载）。未执行真实 prepare 构建/下载。
- `node --import tsx --test packages/services/test/zcodeAgentRuntimeResolver.test.ts`：9/9。
- `pnpm typecheck`：通过；`pnpm lint`：50 warnings、0 errors；`pnpm architecture:check --changed`：0 violations。
- 独立 `pnpm exec tsc -b packages/desktop/tsconfig.main.json`：失败，62 个既有错误；worker 比较修改前后均为 62，当前无错误命中本次修改文件。根 typecheck 未包含 main 项目，因此不得将根检查通过写成独立 main 检查通过。
- 本轮文件定向 oxfmt 与 `git diff --check` 通过；全仓 `pnpm fmt:check` 仅被既有未跟踪 `logs/` 下 5 个 JSON 阻塞，未修改日志。
- 未启动 GUI、未打安装包、未运行性能测量或接触用户数据。
