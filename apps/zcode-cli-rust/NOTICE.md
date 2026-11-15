# NOTICE

The Rust source materials in this directory are derived from **MBearo/ZCode-rs**, licensed under the Apache License, Version 2.0. The upstream source revision is `06ba9781486cffd395d586ec16138c2eeb5edd58`. The full upstream license text is reproduced byte-for-byte in [LICENSE](./LICENSE).

The locally adapted boundary and integration changes in this repository are downstream modifications. Prominent Chinese notices now identify modified upstream Rust source files and extracted Rust test modules; existing upstream copyright notices, including **Copyright 2026 Z.AI Co., Ltd.**, are retained. This source attribution does not imply product feature parity or completeness. JSON/schema assets, Cargo manifests and lockfiles, license coverage, third-party dependency notices, and native binary distribution requirements remain subject to separate review; this NOTICE does not claim complete legal or distribution compliance.

Third-party dependency licenses for native binary distributions have not been audited in this task and must be reviewed before release. This NOTICE and the source LICENSE do not by themselves satisfy that distribution review.

## 上游 3.18.2 上下文语义参照（2026-11）

`apps/zcode-cli-rust` 的指令公告、`total_tokens` 预算与 system 字节快照按官方产品上游
`zai-org/ZCode@fec97590`（3.18.2）的语义重写，实现按本仓 crate 边界（`domain` / `core` /
`model` / `state`）。MBearo/ZCode-rs 参考树修订 `a7a980de32da5da539d361e937702610b801e03d`
（Apache-2.0）仅用于上下文公告与预算扣减的**形状参照**（`crates/context/src/{instructions.rs,announce.rs,system.rs}`）；
未复制其代码结构、未采用其 40-crate 布局或协议内核，也未搬运其 `NOTICE.md` 中的业务声明。
新增/修改文件以显著中文段落标注来源与修改原因；本仓 `LICENSE`（Apache-2.0 全文）与上表中的
上游版权（含 `Copyright 2026 Z.AI Co., Ltd.`）继续适用。引入第三方依赖未变。
