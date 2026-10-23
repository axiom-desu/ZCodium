# contracts + CLI 拆分片的公开契约不变式

本 spec 承接 `lint-debt-retirement.md` 中 contracts 与 CLI 的行数存量分片。只收敛已完成的
按职责拆分，不重做拆分，不改产品规则、协议字段、admission/queue/persistence 语义，也不扩展到
TS TUI/debug、其它 core 目录、Rust、gate 或 spec 根。

## 范围

| 区域                 | 拆分前                                             | 拆分后                                                                                                   |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| events reducer       | `contracts/src/events/event-reducer.ts`            | `event-reducer.ts` + `event-reducer-handlers/{session-lifecycle,turn-control,tool-permissions,types}.ts` |
| browser control 契约 | `contracts/src/interfaces/browser-control.port.ts` | 同名 barrel + `interfaces/browser-control/{context,commands,results,port}.ts`                            |
| session store 契约   | `contracts/src/interfaces/session-store.port.ts`   | 同名 barrel + `interfaces/session-store/{session,message,part,usage}-contracts.ts`、`store-ports.ts`     |
| model 契约           | `contracts/src/model/index.ts`                     | 同名 barrel + `model/contracts/*`                                                                        |
| workflow 契约        | `contracts/src/workflow/index.ts`                  | 同名 barrel + `workflow/contracts/*`                                                                     |
| core turn methods    | `core/src/runtime/internal-turn-methods.ts`        | 同名 barrel + `internal-turn-methods/*`                                                                  |
| CLI 入口             | `cli/src/{run,prompt-command}.ts`                  | 原文件 + `run-arguments.ts`、`prompt-command-center.ts`                                                  |

## 不变量

- 公开导出面与 Git HEAD 一致：导出名字、`type`/`value` 分类、类型文本与 receiver 不变。
  只允许把实现搬到同包相对模块，由原入口 barrel re-export；不新增 `any`、`@ts-ignore`、
  `oxlint-disable`，不用虚假空导出消除 unused。
- `event-reducer` 的 handler 表按 event type 单表查找；分片只改变文件归属，不改变事件处理顺序、
  payload 解析、projection 字段或未知事件的 `updatedAt` 兜底。
- 拆分后的 schema/端口文件不得丢字段或放宽校验；model/workflow 的 zod schema 与端口接口保持
  HEAD 的字段集与可选性。
- `internal-turn-methods` 保持 `this: AgentRuntimeInternal` receiver 与原方法签名；不转移
  mutable state 所有权，不引入第二条写入路径。这里只是按职责保守收窄接口，不是 P1-A 完整解耦。
- 新 helper 模块不超过 400 有效行；未使用导出优先删除本地冗余实现，不伪造 re-export 掩盖。
- CLI 保持原启动/参数解析/prompt 提交流程；新增模块只承载拆分出的纯函数/局部状态。

## 回归测试

`apps/zcode-cli/packages/contracts/test/public-export-surface.test.ts` 对比工作树与
`test/fixtures/public-export-surface.json`（由 HEAD 生成）。基线更新步骤：

```bash
git worktree add --detach /tmp/head-wt HEAD
node --import tsx --input-type=module -e '
import fs from "node:fs";
import { exportSurface } from "./apps/zcode-cli/packages/contracts/test/public-export-surface.ts";
const s = exportSurface("/tmp/head-wt/apps/zcode-cli/packages/contracts/src");
fs.writeFileSync("apps/zcode-cli/packages/contracts/test/fixtures/public-export-surface.json", JSON.stringify(s, null, 2) + "\n");
'
```

只在确认 HEAD 基线本身变化时更新；拆分不得改基线。

## 验证

- `@zcode/contracts`：`typecheck`、`test`、raw `oxlint src`。
- `@zcode/core`、`@zcode/cli`：`typecheck`；本片文件 raw `oxlint`。
- `pnpm check:zcode-cli-rust-contract-assets`（合同资产 --check）。
- CLI 没有 `test` script，不伪造测试命令；需要时只跑现有脚本。
