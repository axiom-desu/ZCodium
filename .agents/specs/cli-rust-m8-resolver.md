# M8：Services 端 Rust runtime resolver 与存储能力描述

> 本文件补充 [cli-rust-m8-desktop.md](./cli-rust-m8-desktop.md)，只描述 services 侧
> runtime 选择与存储能力描述（resolver）闭环。Host 的 native transport、Host 控制帧复用、
> Electron E2E 仍以 M8 主 spec 为准，不在本文件展开。

## 问题与缺陷（实现前确认）

当前 `resolveDefaultZCodeAgentCommand` 的行为与 M8 产品规则不一致：

1. Rust 是「Preview 口味自动启用」：解析链把 `resolvePackagedZCodeCliRustCommand` 排在 TS
   bundle 之前，只要随包目录存在 `resources/rust/zcode-cli-rust` 就选中，没有显式 runtime
   开关，也没有默认 TS 语义。`ZCODE_AGENT_SERVER_RUNTIME` 完全未被读取。
2. 随包 Rust binary 缺失时静默落回 TS bundle，违反「显式 Rust 缺 binary 必须失败」。
3. 开发态没有从本仓 Cargo `target` 发现 Rust binary 的路径；现有候选只看 `process.cwd()`，
   匹配的是仓库内 stage 目录或「任意 cwd 下的同名程序」。
4. `ZCodeAgentCommand` 只有裸字符串 `storagePreparationEntry`，无法表达 Rust 的
   `native-process` 存储准备；Host 无法据此区分 node-worker 与原生进程 transport。
5. tap dev proxy 重建命令时丢掉了 `storagePreparationEntry`，被代理的命令失去存储能力。

## 唯一 owner 与顺序

```text
ZCODE_AGENT_SERVER_COMMAND (显式，最高优先级，custom)
        │  否则
ZCODE_AGENT_SERVER_RUNTIME 解析 → ts | zcode-cli-rust | 未知(throw)
        │
        ├─ ts  → monorepo dev bundle → 桌面打包 Electron Node bundle → 已部署 native 兜底
        └─ zcode-cli-rust → packaged/bundled resource → 开发态 Cargo target（仅 development）
                          → 缺失则 throw（不回退 TS）
```

Services resolver 是「runtime 选择 + transport 能力描述」的唯一 owner。Host 只消费
`ZCodeAgentCommand`，不重新推断 runtime，也不缓存第二份选择结果。

## 契约

```ts
export type ZCodeAgentStoragePreparation =
  | { kind: "node-worker"; entry: string } // 运行已知 JS 存储 Worker（同一 bundle）
  | { kind: "native-process" }; // 复用 resolved command/args/cwd/env 启动原生进程

export interface ZCodeAgentCommand {
  storagePreparation?: ZCodeAgentStoragePreparation;
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
```

- `storagePreparation` 唯一，不再有 `storagePreparationEntry`。
- `supportsStorageStartup` 表示常规 Agent 会发合法启动状态。只有已知的随包/本仓 runtime
  分支才声明它；`ZCODE_AGENT_SERVER_COMMAND` 自定义命令与已部署 native 兜底不推断能力。
- 已知分支：
  - `zcode-cli-rust`：`storagePreparation = { kind: "native-process" }`，
    `supportsStorageStartup = true`，`env` 不含 `ELECTRON_RUN_AS_NODE`。
  - TS bundle（monorepo dist / Electron Node bundle）：
    `storagePreparation = { kind: "node-worker", entry: <zcode.cjs> }`，
    `supportsStorageStartup = true`。
  - monorepo 源码 `tsx` 分支没有可执行的 Worker 入口，不声明 `storagePreparation`，
    但仍是已知 runtime，保留 `supportsStorageStartup`。

## runtime 选择与失败语义

- `ZCODE_AGENT_SERVER_RUNTIME`：未设置、空串或 `ts` → TS；`zcode-cli-rust` → Rust；
  其他值 throw，不静默按 TS 处理。取值 trim + 小写后比较。
- `ZCODE_AGENT_SERVER_COMMAND`：显式最高优先级。命中时按既有自定义命令语义返回
  `command/args/cwd`，不带 `storagePreparation` / `supportsStorageStartup`。
- 显式 Rust 且 packaged/bundled/开发态都找不到 binary → throw（fail-closed），不回退 TS。
  撤销选择或设为 `ts` 才是回退。

## 开发态与打包态 binary 发现

- 打包态优先 `process.resourcesPath/rust/zcode-cli-rust`（`resolveExistingPath` 候选链第一项）。
- 开发态额外允许从仓库锚点（`import.meta.dirname` 上溯到仓库根）发现
  `apps/zcode-cli-rust/target/debug/zcode-cli-rust`，缺失时后备
  `target/release/zcode-cli-rust`。仓库锚点避免「仅按 cwd 命中任意同名程序」。
- 开发态发现仅在 `ZCODE_RUNTIME_ENV=development` 生效，且只在显式 selector 分支被调用；
  测试/打包默认 production 不启用。

## tap dev proxy

`wrapZCodeAgentCommandWithStdioTapDevProxy` 重建命令时原样保留 `supportsStorageStartup`
与 `storagePreparation`，只替换 transport 包装。

## 验收

- 实际调用 resolver 断言：默认/`ts` 不选随包 Rust；显式 Rust 在有 TS bundle 时仍命中；
  缺 binary 与未知值失败；custom command 优先且无能力描述；Rust/native 与 TS/worker 的
  descriptor、`supportsStorageStartup`、`ELECTRON_RUN_AS_NODE` 事实。
- 直接调用开发态 finder（注入临时仓库根）验证 debug → release 优先，并验证 production
  不启用。
- 通过真实 tap 状态文件与 dev 环境验证包装后 descriptor 不丢失。
- 运行 `node --import tsx --test packages/services/test/zcodeAgentRuntimeResolver.test.ts`、
  `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 边界

- 不修改 `packages/desktop` 文件、不改 M8 主 spec、不新增 UI/platform 接口。
- Host 侧 native transport 与非 Worker 握手由 M8 主 spec 负责；本文件只保证 resolver 输出
  正确的能力描述。
