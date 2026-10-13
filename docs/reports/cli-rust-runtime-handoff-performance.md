# CLI Rust vs Node runtime 性能对照（受控本地 fixture）

> 交接状态：下列数据由子 agent 报告，但原始日志和测量入口未留存在当前环境，尚不可复核。只保留为待重跑的草稿，不作为 milestone 性能验收证据；接手者需提供可重复入口、独立初始 DB 并交替启动顺序后重新测量。

## 范围与结论边界

- 对照标签为 Node debug runtime（当前现成 CLI bundle `apps/zcode-cli/packages/cli/dist/zcode.cjs` 由 `node v24.19.0` 启动；bundle 自身优化/调试级别未独立核验）与 Rust debug 二进制 `apps/zcode-cli-rust/target/debug/zcode-cli-rust`。该标签和构建状态限制意味着结果**不构成 release 性能结论**。
- Linux，5 轮/运行时。每轮创建一个全新的临时 root，Node、Rust 顺序运行并共用该轮的 HOME、storage、SQLite DB、workspace 和 loopback dummy model fixture。每轮结束清理临时 root；无用户 HOME/DB/provider 凭据继承，无外网模型访问。
- 复用 `scripts/zcode-cli-rust-interop-runtime.mjs` 的 `prepareHome`、`modelServer`、`startRuntime` 和受控 stdio RPC 生命周期。测量启动计时从 spawn 前至 `createSession` 成功响应（作为可重复的 startup-to-ready 边界）；随后测量相同的 `v4/conversation/subscribe` RPC 往返。subscribe 后空闲 1 秒读取 Linux `/proc/<pid>/status` 的 `VmRSS`。不发送模型请求，因而指标只覆盖启动/简单协议调用/静置进程，不代表生成吞吐或完整任务性能。
- Node 先运行、Rust 后运行，顺序固定；每轮根目录隔离但同轮共享 DB。未随机化顺序，文件系统缓存、环境差异及 debug 构建实现都可能影响结果。未执行 release 构建或做统计显著性检验。

## 原始测量

时间单位 ms；RSS 为 KiB。`ready` 是 spawn 至 `createSession` 成功，`RPC` 是其后 `v4/conversation/subscribe` 往返。

| 轮次 | Runtime    | Startup → ready | subscribe RPC | 空闲 RSS |
| ---: | ---------- | --------------: | ------------: | -------: |
|    1 | Node dist  |         827.934 |         4.848 |   424764 |
|    1 | Rust debug |         135.640 |         1.953 |    57468 |
|    2 | Node dist  |         835.395 |         4.416 |   425548 |
|    2 | Rust debug |         137.339 |         2.594 |    57428 |
|    3 | Node dist  |         825.032 |         4.429 |   428796 |
|    3 | Rust debug |         168.067 |         2.577 |    56944 |
|    4 | Node dist  |         829.700 |        11.644 |   428860 |
|    4 | Rust debug |         136.386 |         2.086 |    57484 |
|    5 | Node dist  |         858.980 |         4.673 |   428476 |
|    5 | Rust debug |         146.021 |         5.644 |    57388 |

五轮中位数：

| 指标            |  Node dist | Rust debug |
| --------------- | ---------: | ---------: |
| Startup → ready | 829.700 ms | 137.339 ms |
| subscribe RPC   |   4.673 ms |   2.577 ms |
| 空闲 RSS        | 428476 KiB |  57428 KiB |

## 解释

本组受控样本中，Rust debug 启动至 `createSession` 成功及空闲 RSS 的观测值较低；subscribe RPC 的中位数也较低，但样本很少且单轮波动明显。Node dist 的构建标识未在本测量中独立核验，因此不据此推断 Node/Rust release、跨平台表现、稳态负载或模型任务的相对性能。仅报告上述具体 artifact、环境与观测值。
