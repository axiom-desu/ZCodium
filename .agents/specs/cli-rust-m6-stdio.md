# Rust CLI M6：stdio / RPC / V4 投影实质验收

本轮只验收 `apps/zcode-cli-rust/crates/app-server` 与本 spec；优先使用 Rust 本地临时 IO/内存 sink 集成测试，不改协议/UI 接口、其他 crate、总 runtime spec、package 或提交内容。对照当前仓库 TS 协议实现，测试真实 framing、路由/ACK 和 V4 snapshot/stream delivery，不以 DTO 自构自测替代语义验证。

## 所有者与边界

- stdio adapter 按行拆分输入、限制单请求字节数、解码为现有 `Input`；Server 是 RPC 路由和 pending token 的唯一 owner；Runtime 持有 topic 事实/序号/快照，Delivery 只维护订阅投影、缓存与发送节奏。
- 事件顺序：输入请求 → App Server 路由/登记 pending token → Runtime 回复 → 对应 JSON-RPC response/ACK → 同批之后的 V4 frame。topic 订阅先由 Runtime `topicOpen` 回复提供状态，成功构建首帧后才登记/替换订阅。
- Desktop continuous 保持在线连续帧；web replayable 保持 snapshot + replay/resync 连续性；序号 gap、buffer overflow、编码失败不得伪造连续性，按既有恢复/失败语义处理。不得加 fallback 或新接口。

## 验收场景

1. stdio：多帧连续输入、单帧跨多次读取、空白行、非法 JSON 后续合法帧、EOF 未带换行的尾帧、恰好达到请求上限及超限。断帧/坏帧不得污染下一帧；超限按既有 fail-close 规则。
2. RPC：未知 method 返回 method-not-found；无 id 通知不回 ACK；已路由 RPC 的 token 只匹配其回复；V4 subscribe 回复先有带 `subscriptionId/mode/logEpoch` 的 ACK，再有 initial frame。通过完整 `serve` 内存输入/输出/router 覆盖 desktop 的 `desktop-continuous` 与 web/mobile 的 `web-remote-replayable`，分别断言 ACK `subscriptionId` 与对应 frame；同连接同 topic 重订阅仅在新首帧编码成功后替换旧订阅。重订阅首帧编码失败必须保留旧订阅及其 owner/sequence；新订阅首帧编码失败不得登记订阅。若当前 frame 编码器无法注入错误，不改生产接口伪造错误，使用现有无效 snapshot 或超大 payload 触发真实失败，并检查相关状态不变。
3. V4 投影：initial snapshot 的 `(0, seq]` 与真实快照 payload；resume 按 profile 过滤 delta 但保留连续 seq 区间；在线连续增量与 gap snapshot recovery；重同步回复覆盖在途增量，且对齐回复仍以 `(N,N]` 收口；V4 framing 对 UTF-8 分片、重组字节和 CRC32 有边界验证。

## 完整 loop 测试补充（接续 M6）

仅提取/新增 app-server 内的独立测试文件（每文件不超过 400 行），不改变生产路由或 delivery 行为。现有 `server.rs` 内 ACK 两 profile 测试已具备 `subscriptionId` 关联断言；重订阅失败测试需要以实际 EOF + pin release 收口 runtime，不能等待 `serve` 所持 sender 先关闭，也不能把 initial frame 当作失败后的 online frame。

```text
内存 Input → serve（pending token / 路由唯一 owner）→ ClientMsg runtime router
                                                          ↓
Values sink ← ACK / initial / online / recovery ← ServerMsg reply + event
Desktop: desktop-continuous     ─ 保留 text 与 inputText ─┐
Web:     web-remote-replayable   ─ 仅保留 text           ─┴ 同一 topic seq
```

完整 loop 验收补充：

- 输入未知 method、通知、两个带不同 id 的 RPC；runtime 逆序回 token 并插入未知/重复 token，输出只能回对应请求，通知无响应。覆盖 HostRequest/HostNotification → sink、Input::Response → HostReply，以及 Invalid → 后续合法请求、TooLarge → 唯一 Eof 并停止接收后续输入。
- 两 profile 分别经实际 `serve` 输入/输出和可控 runtime transport 完成 resume subscribe：ACK 在 initial 之前，profile 过滤不改变 `(fromSeq,toSeq]`；在线仅有 inputText 的区间在 replayable 中仍发空 deltas 帧。使用输出/请求通道作事件屏障，不用 sleep 掩盖同步问题。
- seq gap 后完整 loop 必须向 runtime 路由 TopicSnapshot，而不是输出伪连续 delta；在途事件由 snapshot 回复覆盖，随后增量从 snapshot seq 继续。显式 resync 校验 connection/topic/subscription owner，ACK 在 recovery 前；已对齐 resume 回复也发 `(N,N]` recovery 帧。
- 新订阅与重订阅均以超过真实 codec assembly 上限的 payload 触发失败：释放本次 TopicOpen pin，不登记新订阅；旧 subscriptionId/profile/seq 继续在线，不能被失败的另一 profile 替换。成功重订阅释放旧 pin，并由新 subscriptionId 接收后续帧。
- 测试关闭输入时必须收到唯一 ClientMsg::Eof；runtime 显式结束后 `serve` drain 最终 buffered frame。测试超时只用作死锁失败保护，不用作事件同步或产品兜底。

## 本轮交接范围

已落地完整 loop 测试：两 profile 的 snapshot subscribe ACK/frame 关联和顺序；真实 assembly 超限导致重订阅失败时保留旧 subscriptionId/profile/seq 并释放本次 pin；RPC 逆序 token 回复与通知无响应。上面的其余完整 loop 场景为后续验收要求，尚未新增对应测试，不声称已通过。既有 delivery 层测试不能替代完整端到端验收。

## 验证

测试必须实际运行且使用临时/内存数据，不启动真实模型、真实 HOME/DB。仅报告所执行的 Rust 定向测试与可用仓库 gate 真实结果；这批测试不等于 M6 全面产品 parity，也不代表 M7/M8 完成。
