# Agent 协议握手门禁与响应校验可读化

## 问题与修正

真机曾把 `session/messages` 的 Zod issues JSON 当作消息渲染：本机要求
`sessionId/messageId/partId`，对端返回 `sessionID/messageID/id/time`。
响应形状不符是已知事实，不能单凭形状断言对端版本不同。

首轮 A1 (`37f89a9c`) 用 `session/list(limit=1)` 作探针存在遗漏：Node/Rust 的列表响应都没有
`protocol` 字段，因此**不是真正的版本握手**；原先测试只覆盖错误格式化，没有覆盖初始化。
探针沿用业务请求默认 180s 超时还可能回收 Agent。本轮纠正该实现，不保留错误的“已验证”口径。

## 接口、所有者与不变量

- 协议身份由 CLI/runtime 声明，`runtime/capabilities` 返回
  `protocol: { name: "ZCode Protocol", version: 1 }`。Node 使用 shared 常量，Rust 同步声明。
  shared schema 此字段可选（旧 Agent 无此字段），字段值不是 literal，避免把不同版本先折成 Zod 错误。
  legacy v1 与 V4 wire v3 独立，均不升级版本号。
- 响应校验唯一所有者仍是 `ZCodeProtocolClient.resolveResponse`：先对 capabilities 声明的协议身份
  比较 name/version（即使其余 schema 合法也检查），再解析业务 schema。不翻译/修补对端字段。
- 初始化只做只读 `runtime/capabilities` 观测，不读取会话列表、不新建 session/runtime。
  总等待预算 10s（AbortSignal 包含 storage gate 等待；client 不再先 await transport.send，
  写入阻塞也不能拖住已取消的结果）；`lifecycle: observation`，不触发
  `onRequestTimeout` 的 Agent 回收路径，不续期业务活跃。
- `probeAgentProtocol` 只投影此次观测结果，不维护缓存/第二套状态：
  - 明确声明且 name/version 相同：`verified`；
  - 明确声明且不同：`incompatible`，初始化 `available:false`、`agent_protocol_mismatch`；
  - 响应形状不符：`invalid`，初始化 `available:false`、`agent_response_invalid`，不声称版本不同；
  - 旧 Agent 无协议字段、方法不支持、观测超时/存储仍在等待：`unverified`，保留既有
    `available:true` 的可恢复语义，但 `protocolVerified:false`。不宣称已兼容。
  - 存储终态失败、client disposed、传输关闭/写入失败及其它未知异常：交给初始化既有错误路径，
    `available:false`，不得吞成 unverified 或误报版本不同。
- 初始化结果 `protocolName/protocolVersion` 仍描述本机期望；`protocolVerified` 明确是否读到并比较了
  对端声明。后续业务请求仍独立校验响应，握手不保证同版本实现无 bug。
- 错误文本 ≤300 字符，包含方法名、本机身份、对端身份（未知写“未声明协议版本”），
  不含原始 issues JSON/响应体。最多 3 条字段**路径**用于定位，禁止拼 issue.message
  （Zod message 也可能包含对端原始输入）。完整原错误仅保留在 cause 供诊断，不作 UI 正文。
- 同版本的 schema 失败用中性提示“响应格式不符合协议”，不要求用户升级、不谎报版本不匹配。
  `code` 区分 `agent-protocol-mismatch` / `agent-response-invalid`；公开 `reasonCode` 同步映射为
  `agent_protocol_mismatch` / `agent_response_invalid`，禁止两个类别都映射成 mismatch。

## 事件顺序

```text
CLI/runtime（唯一协议身份声明者）
  runtime/capabilities → {protocol:{name,version}, ...capabilities}

initialize → getClient（既有唯一 runtime）
  → probeAgentProtocol → client.request(runtime/capabilities, observation, 总预算10s)
    → resolveResponse → 校验声明身份 → schema.parse
      → verified / incompatible / invalid / unverified
  → 初始化可用性 + protocolVerified（只读投影）

业务请求 → 同一个 resolveResponse → schema.parse
  → 失败时 normalizeResponseParseFailure（有界中性错误，不把 issues JSON 渲染成聊天消息）
```

Desktop continuous 与手机 replayable 交付语义均不改变；不新增 owner、队列、持久化或自动重试。

## 验收

1. 真实 capabilities 形状（无会话）声明 v1 → verified；声明 v3 或其它 name，即使 schema 解析
   本可成功也必须拒绝，错误包含双方版本。
2. 旧 capabilities `{independentPlanState:true}`、方法不支持、storage 等待/超时 → unverified；
   初始化仍可恢复，不触发回收 Agent 的 timeout 事件，测试验证预算覆盖 storage gate。
3. 非法 capabilities → invalid / agent_response_invalid，不误标为 mismatch。
4. 真实 `ZCodeProtocolClient` + 内存 transport 往返测试覆盖以上路径及 schema 失败，
   不是仅对手工构造的 Zod-like 对象测文案。
5. 无协议块/同版本 schema 失败的错误明确说明身份；超过 3 条 issue 只留 3 条路径；
   含敏感值的 issue.message 不进入 UI 文本；全部消息长度 ≤300。
6. Node 与 Rust runtime 的 capabilities 均真实声明协议身份，测试不需模型/真实远端/真实用户目录。
7. 存储终态失败/传输失败不宣称初始化可用；传输写入悬挂仍受预算约束。

关键接口：`probeAgentProtocol(client)` 返回上述只读观测结果；
`assertResponseProtocolIdentity(method, result)` 由唯一 response 边界调用，比较明确声明的身份；
`normalizeResponseParseFailure({method, result, error})` 生成可读、可分类的响应错误。

## 本轮验证

- `pnpm typecheck`、`pnpm lint`（0 warnings / 0 errors）、`pnpm verify:pre-push`
  （lint/format 棘轮和 architecture 均零新增）通过，未改任何基线。
- 真实 protocol client + initialize + runtime preferences / mobile admission / RPC 回归：
  Vitest 12 文件 / 85 通过；隔离 HOME/XDG/data/log，`dist/**` 排除。
- Node `cliLaneIdleReclaim` / `zcodeAgentRuntimeResolver` 按原生 node:test 入口运行：13 通过；
  Node capabilities dispatcher 1 通过。
- Rust `cargo test -p zcode-cli-core`：27 通过；core clippy `-D warnings` 通过。
- `zcodeProtocolClient.ts` 错误类机械拆到 `zcodeProtocolClientErrors.ts`，保留原 timeout error
  re-export，源文件保持 400 行以内；诊断静态词表按源码重新生成。
- 未出新包、未安装；真实 Electron/手机/SSH/WSL/Docker 本轮未验证。

## 范围外

- 不做自动降级、字段翻译、自动重试。
- 不把 protocolVersion 当产品版本号；相同声明版本不代表所有业务 schema 都正确。
- 不增加全局业务请求前握手状态机；此次只修初始化门禁与统一错误边界。
- 真实 SSH/WSL/Docker 和 Electron/手机首屏 E2E 仍需单独验证。
