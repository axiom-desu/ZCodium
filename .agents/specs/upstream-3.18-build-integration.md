# 上游 3.18.2 构建 / 类型整合（G7）

本片只收口类型与构建接缝，不新增业务域、不改 Host/admission/identity/lease/Default-deny 语义。
来源：`.cache/upstream-3.18.2@fec97590`（只读），本分支 WIP 全部保留。

## 1. 所有者与产物边界

- Desktop 的 type owner 仍是各自的 `tsconfig.<project>.json`：`main` / `host` / `scheduler` /
  `app-navigation` / `preload` / `renderer`。根 `typecheck` 必须覆盖全部工程，不得只挑
  host+scheduler。
- `tsc -b` 的产物只能落在 `packages/desktop/out/**`（或各自 `outDir` / `noEmit`）。
  `src/**` 下出现 `.js` / `.js.map` / `.d.ts` / `.d.ts.map` 即视为配置错误，
  不是“可顺手删掉的杂音”。
- 跨工程引用走 `references`；`main` 直接 import `src/scheduler` 与 `src/host` 时，
  必须把对应工程加进 `references`，否则会触发 TS6059/TS6307 并把产物回写到源码目录。

```text
main.ts → src/scheduler/*.ts  ──reference──▶ tsconfig.scheduler.json ──▶ out/scheduler
        → src/host/*.ts       ──reference──▶ tsconfig.host.json      ──▶ out/host
        → @zcode/shared       ──reference──▶ packages/shared (dist 声明)
```

## 2. 类型收口规则

- Electron 44 与 `@types/node` 25 的真实类型变化用显式适配修：窄化、默认值、事件对象形状、
  `unknown` 边界转换；禁止 `any` / `@ts-ignore` / `@ts-expect-error` / 删除 `strict` / 用
  `exclude` 把报错文件移出工程。
- `@zcode/shared` barrel 缺导出时，只在确实由 `platform.ts` 声明、且上游 barrel 导出的类型上补
  `export type`；不复制上游未落地的类型。
- CLI 的 `dist` 声明与 `src` 品牌类型冲突时，先按依赖序重建全部 CLI 依赖，再 typecheck；
  生产代码不得用 `as` 强转掩掉品牌冲突。

## 声明产物同样可重复检查

完整CLI build 后也必须维持lint零新增。node-repl no-progress helper的返回值保持同一结构，
用显式输入/observe返回类型而非私有返回接口，避免tsc为私有类型合成多余`export {}`；
重新生成声明，不手改产物、不忽略dist-types目录、不增加公开API来迁就lint。

## CI 服务安全回归的实际执行者

`test:services-safety` 枚举当前 `packages/services/test` 与扩展服务源码内的测试，按真实导入的
node:test / Vitest 分别执行，不把两种runner混跑，不递归参考树或构建产物。
每次使用临时HOME/XDG/TMPDIR；显式复用已安装的浏览器binary/cache只用于工具，浏览器profile仍为临时目录。
工作树worktree失败收口、并发租约、设计源码authority、App控制与原mobile-directory回归都进入Desktop CI，
不能仅用内存UI smoke代替真实SQLite/Git/Host测试。默认未知runner即失败，不能静默跳过新测试。

## 3. 失败回归（先红后绿）

| 命令                                             | 修复前                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `tsc -b packages/desktop/tsconfig.main.json`     | 78 errors，且把 `electronPort` / `schedulerProtocol` 产物写回 `src/`              |
| `tsc -b packages/desktop/tsconfig.preload.json`  | 3 errors（shared barrel 缺导出）                                                  |
| `tsc -b packages/desktop/tsconfig.renderer.json` | 2 errors（`setImmediate`、CSS 副作用导入）                                        |
| 根 `pnpm typecheck`                              | 1 error（`ZCodeProtocolClientRequestOptions` 缺 `invalidateConnectionOnTimeout`） |
| `turbo --cwd apps/zcode-cli run typecheck`       | 失败（CLI `dist` 与 `src` 品牌类型不一致）                                        |

验收：上述命令全部 exit 0；`tsc -b desktop` 后 `packages/desktop/src/**` 不新增
`.js`/`.d.ts` 产物；`pnpm lint` 0/0；`gate:knip` 无新增；CLI/Web/Desktop 不跑运行时的构建通过。

## 4. 回归守卫

`scripts/ci/desktop-tsconfig-emission.test.mjs` 断言：

1. 每个 Desktop tsconfig 都有 `outDir` 或 `noEmit`；
2. `main` 引用了 `scheduler` / `host` / `app-navigation` 工程；
3. `src/host/electronPort.*`、`src/scheduler/schedulerProtocol.*` 只保留 `.ts`。

该测试不跑 `tsc`，只守卫配置与工作树卫生，避免 CI 里重复全量构建。
`pnpm typecheck` 末尾执行它；`scripts/ci/clean-desktop-typecheck-cache.mjs` 在 typecheck 前清理
Desktop 自己的 `.tsbuildinfo`（production build 会清 `out/`，只删产物会让 `tsc -b` 误报 TS6305）。

## 5. 不在本片范围

- 新增依赖、版本号、全局格式化、catalog/licenses 生成（由主代理统一）。
- `dist`/`out` 的清理脚本行为、Rust 侧构建、真实制品安装。
- 任何未由上游 3.18.2 引入、但需要产品决策的语义变更（先在结果报告列账）。
