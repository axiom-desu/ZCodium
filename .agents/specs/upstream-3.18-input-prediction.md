# Web profile 输入预测（input prediction ghost hint）迁移

上游来源：`.cache/upstream-3.18.2` @ `fec97590`：
`packages/shared/src/zcode-protocol-v4/input-prediction/`、
`apps/zcode-cli/packages/core/src/runtime/methods/input-prediction-sidecar.ts`、
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/input-prediction-handler.ts`、
`packages/services/src/zcode-agent/inputPredictionSwitch.ts`、
`docs/web-remote-control/mobile-input-prediction.md`。

## 当前范围与产品规则

本片只支持现有 Web profile 中的 v4 `ConversationComposer` / Lexical 输入框；旧手机 Web/relay 和 KMP 暂停，不得接线。输入框（composer）是草稿的唯一所有者。预测只是「可明确采纳的灰字提示」：

- 不自动发送、不自动改写草稿；只有用户点「采纳」才把 `draft + text` 写回草稿。
- 不抢焦点、不改桌面选区、不写历史、不持久化、不进入 conversation snapshot。
- 无模型 / 未 resident / 旧 CLI / Rust 未实现 / 开关关闭 → 安静无 hint，不隐式启动会话。
- 用户编辑、发送、停止、页面 dispose、重连都会取消在途请求；迟到结果一律丢弃。
- 预测是临时 UI 状态，desktop continuous 与 mobile replayable 都不复播它。

## 链路与所有者

```text
Web profile ConversationComposer/Lexical (唯一 draft owner, revision++)
  → useInputPrediction + readMobileWebViewport (仅显式 Web + 窄屏)
  → zcodeAgentService.conversationInputPredictionV4 (existing-only)
  → CLI handler (session in-flight + bounded LRU + generation validation)
  → existing runtime model call (AbortSignal 贯通至真实模型)
  → 显式点击采纳 → Composer/Lexical 自己更新 draft；绝不自动 send

编辑/停止/dispose/reconnect → cancel RPC → handler abort → model transport abort
``

- **Composer**：唯一草稿所有者。Hook 返回候选；明确点击后通过 Lexical 的既有输入 API 更新草稿，不自动发送、不抢焦点。预测门仅在 `readMobileWebViewport()` 为 true 时开启；桌面 profile 不产生请求。
- **CLI handler**：会话级 in-flight 与结果缓存的唯一 owner。新请求中止同会话旧请求（回 `cancelled`）。
  缓存键 `(sessionId, revision, normalizedDraft)`；`unavailable`/`cancelled` 不缓存。
- **模型调用**：只使用当前 runtime 已配置模型（`getSessionModelSelection() ?? restoredModelSelection`），
  不另选 provider、不启动第二个 runtime、不建立 accepted 队列。
- **代际**：`loadSession` 返回 record 身份令牌；结果返回前若会话 record 已换代/移除，回 `cancelled`，
  旧代际结果不得写给新会话。

## 线格式（严格）

`v4/conversation/inputPrediction` 与严格取消方法 `v4/conversation/inputPrediction/cancel`，方法常量与 `hello.capabilities.inputPrediction` 在
`packages/shared/src/zcode-protocol-v4/`（managed 模块 `remote-input-prediction`）。取消只按 `sessionId + requestId` 命中当前 controller；无匹配请求是幂等成功。UI hook 在 edit/stop/dispose/reconnect 发送 best-effort cancel，且始终丢弃迟到响应。

请求（`.strict()`）：`sessionId`（≥1）、`revision`（int ≥0）、可选 `draft`（≤4000）、
可选 `requestId`（1..128）。响应（`.strict()`）：`decision` ∈
`show | suppress_below_threshold | suppress_no_context | unavailable | cancelled`、
`candidates`（≤3，`text` 1..40 单行非空白，`confidence` 0..1）、`topConfidence`、可选 `requestId`。

能力判断必须写 `=== true`；旧 Host 字段缺席等价 false。Host 的 hello cap 与服务方法门禁共用
`isRemoteInputPredictionEnabled()`（`ZCODE_REMOTE_INPUT_PREDICTION`，缺省开启，"1" 开启，其它关闭）。

## 失败语义

- 服务层不抛预测错误：开关关闭、无运行时、旧 CLI method-not-found、schema 不合法、通道失败
  统一回 `unavailable`（尽量回显 `requestId`）。
- CLI：会话不在内存 / 轮数不足 → `suppress_no_context`；无模型 / 超时 / 模型失败 → `unavailable`；
  同会话被替代 → `cancelled`。降级日志只记事件名、sessionId、错误消息，不记草稿与正文。
- UI：任何异常 / 超时 / `decision !== "show"` → 无 hint、不重试轰炸、不提示错误。取消信号必须经 RPC 取消方法到达 handler，继而传到真实模型调用。
- 缓存命中也必须先校验当前 session record generation；编辑、stop、dispose、reconnect 的取消后不得缓存/返回迟到结果。诊断日志仅记录错误分类，不包含错误正文、prompt 或草稿。

## 验收

- shared：schema 严格性、decision 集合、候选边界（空白/换行/超长/超量）与 `emptyInputPredictionResult`。
- core：提示词上下文裁剪、JSON 容错、suffix 收敛、去重、阈值/轮数门槛。
- bootstrap loopback：真实 AgentRuntime + 临时 HOME/SQLite + loopback 模型：
  - `show` 只调用一次模型；会话消息数/stateRevision 不变（未 accepted、未进 CommandInbox）；
  - 新请求替代旧请求 → 旧请求 `cancelled`，迟到结果不回给新 revision；
  - 会话 record 换代后旧请求结果被丢弃；`dispose` 中止在途；
  - 会话不在内存 / 无模型 → 不发起模型调用，回 `suppress_no_context`/`unavailable`。
- services：开关缺省/关闭/显式开启；hello cap 与方法门禁一致。
- 浏览器真实 Web `ConversationComposer` + Lexical：正例 `show` 显示可明确采纳的灰色提示；采纳只更新 Lexical 草稿；反例 `unavailable`/迟到/编辑后无 hint，不自动发送、不写历史、不抢焦点。loopback 验证取消实际中止模型 transport，缓存命中需拒绝旧 generation。

## 本次收口的额外验收与实现边界

- 真实 Chromium 验收使用生产 `ConversationComposer`、Lexical 与现有 composer fixture 构建方式；生产 hook 必须由非空 snapshot 启用。仅窄 Web 在 `show` 时展示 hint，accept 精确追加候选；Desktop 与宽 Web 不得请求。edit/stop/submit/dispose 后响应迟到不得展示。验收不允许 autoFocus、auto-send。
- 真实 loopback Bootstrap 验收通过真实 cancel dispatch 中止真实模型 HTTP 请求，并断言服务端 `response.close` 发生时 `response.writableFinished === false`；仅 AbortSignal 不构成传输层验收。
- Composer 输入预测逻辑放在 `v4/composer/useComposerInputPrediction.ts`，大组件只做参数装配。accept 必须保留现有 Lexical 结构化 mention；不得以 `setText` 展平结构节点。Lexical append API 增加可选精确 suffix / 保留焦点选项，既有默认 append 空格与选择末尾行为不变；预测接受使用 `SKIP_DOM_SELECTION_TAG` 与 `SKIP_SELECTION_FOCUS_TAG`，不抢未聚焦手机焦点。

## 不在本片

旧 mobile Web/relay、手机 KMP 原生端、真实公网/SSH 远端、Rust input prediction。Rust 未实现时方法不存在，服务层统一回 `unavailable`，不伪装成功。
```
