# CI 冷构建依赖序与验证编排（F1）

本片只修「CI 冷 runner 暴露、本地 warm cache 掩盖」的构建与编排缺口，不新增业务域，
不改 Host/runtime/CommandInbox/identity/lease/Default-deny 语义，不放宽任何棘轮或测试断言。

## 1. 实际证据（固定来源）

- `43692966383`：`cli-rust.yml` / `protocol-schema` 的 `pnpm build:zcode-cli-rust-oracle-deps`
  在 `@zcode/core#build` 失败 `TS2307: Cannot find module '@zcode/session-control/contracts'`。
- `43692966466`：`desktop.yml` / `remote-assets` 的 `pnpm prepare:remote-assets` 在
  `packages/server` 的 `build:remote`（esbuild）失败，缺 `@zcode/session-control/dist/contract.js`
  与 `dist/application/app/index.js`；同一 run 的 `Release tests` 有 3 条既有 release 测试
  因 `knip.json` 的 JSONC 尾逗号 `SyntaxError` 失败；`Services safety` 在 Chromium 未安装时
  仍被执行，报 `Executable doesn't exist .../chromium-1217/chrome-linux64/chrome`。

## 2. 根因与所有权

```text
apps/zcode-cli 的 turbo 图  ──覆盖──▶ apps/zcode-cli/{packages,tools} 之间的构建序
根 workspace 图（无调度器）  ──缺口──▶ packages/session-control（exports 指向 dist/**）
                                        ├─ @zcode/core 的 tsc 需要其 .d.ts
                                        └─ @zcode/services 的 esbuild 需要其 .js
```

- `packages/session-control` 是本仓唯一「根 `packages/*` + dist 导出 + 有 workspace 消费者」的包；
  `dist/` 被 `.gitignore` 忽略，所以冷 runner 必然没有产物，本地残留产物把问题藏起来。
- 唯一所有者：`scripts/ci/build-workspace-prerequisites.mjs`。它按 workspace 清单推导出
  「dist 导出且被其他 workspace 包依赖、且不在 CLI turbo 图内」的前置包，并按自身依赖序构建。
- 消费者只调用这一条入口（root script、`scripts/prepare-prebuilds.mjs`、CI workflow），
  不再各自拼 `pnpm --filter … build`，避免顺序再次分叉。
- 不允许的替代修法：改成 `external`、把 exports 指向 `src` 掩盖构建、在 CI 里信任残留 `dist`、
  构建前 `rm -rf dist`（并行任务可能正在读同一共享 `dist`）。构建只在原地由 `tsc` 覆写。

## 3. 消费者清单（必须前置）

| 入口                                                   | 位置                                 | 为什么需要                        |
| ------------------------------------------------------ | ------------------------------------ | --------------------------------- |
| `pnpm build:zcode-cli-rust-oracle-deps`                | root `package.json` / `cli-rust.yml` | turbo 只排队 CLI 包，core 要 d.ts |
| `pnpm build:zcode-cli-agent-deps`                      | root script / `desktop.yml`          | 同上，desktop 的 agent 依赖构建   |
| `pnpm prepare:remote-assets`                           | `scripts/prepare-prebuilds.mjs`      | server esbuild 要 dist 的 js      |
| `pnpm build:bootstrap`                                 | root script / `desktop.yml`          | desktop tsup 打包 services        |
| `scripts/build-desktop-agent-cli.mjs`                  | desktop/remote agent bundle          | 显式 CLI 清单里没有根前置包       |
| `pnpm --filter @zcode/desktop build:no-runtime-assets` | `desktop.yml`                        | tsup 打包 services                |
| `pnpm --filter @zcode/web build`                       | `desktop.yml` 启动回归               | vite 打包 ui/services             |

失败语义：前置构建失败即直接失败并输出真实 tsc/esbuild 错误，不回退到残留产物、不降级为 external。

## 4. 配置与编排修正

- `knip.json` 必须是严格 JSON：`knip` 自己容忍 JSONC，但 `scripts/ci/*.test.mjs` 用
  `JSON.parse` 读真实配置。修配置文件，不放宽测试断言。
- `knip.json` 不再使用 `ignoreIssues`：`scripts/ci/pdf-render-tool-standalone.test.mjs` 明确禁止它。
  design-plugin 的 `test/fixtures/**` 是「只做静态解析、绝不执行」的 fixture（其 `require` 是哨兵），
  不是生产代码，因此整体从 knip 扫描范围排除，而不是按 issue 类型静默抑制。
- 编排规则：步骤失败后，后续**提供验证覆盖**的步骤与**提供前置工具**的安装步骤都以
  `!cancelled()` 执行，一个早期失败不能让后面的门禁变成「skipped」而静默丢覆盖；
  fail 状态保持（不用 `continue-on-error`、不删测试）；前置工具没装好就是真实失败，
  不能出现「安装被 skip、依赖它的检查照跑」的组合。

## 5. 回归守卫

`scripts/ci/build-workspace-prerequisites.test.mjs`（现有 `node --test scripts/ci/*.test.mjs` runner 可发现）：

1. 前置集合推导：`@zcode/session-control` 在集合内、`@zcode/desktop`、CLI 内部 dist 包不在集合内；
2. 冷态标记：`packages/session-control/dist/contract.js` 被 git 忽略（冷 runner 无产物）；
3. 顺序：root `build:zcode-cli-rust-oracle-deps`/`build:zcode-cli-agent-deps`/`build:bootstrap`
   与 `scripts/prepare-prebuilds.mjs`、`scripts/build-desktop-agent-cli.mjs`、`desktop.yml`、
   `cli-rust.yml` 都先调用前置再构建消费者；
4. `--plan` 只输出计划、不执行构建；脚本不含删除 `dist` 的路径。

验收命令：`node --test --test-isolation=none scripts/ci/build-workspace-prerequisites.test.mjs`、
`pnpm gate:knip`、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 6. 不在本片范围

- 首次真正清空产物后的冷构建重跑由主代理执行（本片不删共享 `dist`）。
- `sourceAuthorityLoopback` 超时、Clipboard fixture、Windows 测试由 F2 负责。
- 锁文件、生成资产、统一 fixture 由主代理负责。
