# P2：3.17 远端 backend 正确性同步

## 来源、范围与前置

权威依据：`git diff 3c5b2276 a9fe401e -- packages/server/src/remote`，辅助盘点 `/tmp/zcodium-3.17-remote-inventory.md` F1–F8。已读取总 spec、architecture skill，运行 architecture check 与 `architecture:context server`（server 未受管、无依赖合同）。

本轮协调授权扩展：除原 remote backend 文件与测试外，可修改 shared source-server 公开码、归一化与日志脱敏，server source-server probe/transportAdapter，Desktop Host release resolver，以及 UI 既有错误分类/中英 i18n 和对应测试。只新增 `remote-authentication-unsupported`、`remote-platform-unsupported` 两个公开码与运行时 schema；不引入其他 3.17 错误码或生命周期能力，不改 Host registry/连接 owner、rpc、mobile-policy、provider、lock，不 commit/push；保留 TOFU、WSL owned child 回收、proxy 和既有 shell/upload 边界。

## 规则、所有者与接口

- F1：显式数字退出码优先（包括 0），signal 转 `128 + signal`，无退出信息为 255；首个 exit/close 只通知一次。SSH buffered exec 等 close 收齐输出，但保留 exit 的真实码。
- F2：只有 name/instructions/prompt 明确出现 OTP/2FA/动态口令等文字才标记额外验证；提示数与轮数不构成证据。回答密码的流程不变，每次连接重置证据；TOFU 拒绝原因仍优先。
- F3：ready 前 client-timeout 为握手超时，ready 后为 Keepalive 超时（15 秒 × 4 间隔约 60 秒），不能在断连清状态后再判断阶段。
- F4：SSH backend 持有唯一连接尝试及失败出口；并发 ensureConnected 复用当前尝试。ready 前 error/end/close 或同步 connect 异常均立即拒绝全部 waiter，清理本次监听与 promise，允许下一次调用重试；不依赖 dispose 或额外超时。dispose 先拒绝在途等待、移除临时监听，再关闭 client；迟到 ready/error/旧 close 不复活凭据、不作为新尝试完成依据。
- F4 review 修复决策：ssh2 1.17.0 `client.js` 的 socket end/close 会清除 readyTimeout；收到 banner 后 FIN 可无 error。其 Client 事件不带 socket generation，旧 socket close 还会清空 Client 当前 callbacks/channel manager，故不能在同一个 Client 上直接开始后继 flight。backend 保持唯一 connectingPromise/失败出口，不增加第二队列；首次使用构造期 Client，重试创建新 Client（一个 Client 只 connect 一次），Client identity 即 generation。常驻 error/end/close、ready、keyboard-interactive 及异步 TOFU 拒绝回调均须验证当前 Client 且 backend 未 dispose；旧 error 保留 no-op sink。每次尝试重置 TOFU/额外验证证据，TOFU 仍 fail-closed 且拒绝优先。退役 Client 关闭，不等待旧 close 再启动后继。此 owner 调整仅限 backend 内部传输对象，不变更 Host owner/lease、协议或持久化。
- F5：身份命令为 `bash --noprofile --norc -c`，使用 `__ZCODE_WSL_IDENTITY__` 哨兵隔离噪音；distro 使用列表的规范名称，user 复用 shared 验证。成功身份可缓存，失败只清当前 promise，不覆盖后续结果。
- F6：WSL 错误优先 stderr，其次正确解码的 stdout，再原错误；保留 cause 与数字退出码。
- F7：Docker daemon probe 保留 CLI 原因；backend 缓存成功探测，失败不缓存。可选 `IRemoteBackend.diagnoseExecFailure()` 在实际远端命令非零后清除旧探测结果并重探；transportAdapter 的 exec、安装 staging/update 和 probe 消费诊断。daemon 故障保留 backend 明确的公开码，健康则保持原命令结果/错误；成功命令不诊断。不新增连接或重试 owner。
- F8：平台不支持通过 `remote-platform-unsupported` typed error 表达，文案不使用裸斜杠；现有 connect/deploy/probe 使用同一平台边界，probe 不得包装丢码；Host release resolver 在不支持的平台或架构时、任何制品 IO 之前抛相同分类。
- F2：额外验证证据只在认证失败时产生 `remote-authentication-unsupported`（保留 cause、retryable=false），普通密码错误仍是原可纠正认证分类。shared normalize 优先保留专用码，UI 在既有错误面板显示专用中英文原因，不把不可恢复 2FA 归入补密码入口或自动重试。
- 日志统一脱敏 unix/npipe/tcp daemon URL；裸 socket 路径仍过滤，只允许明确 `: connect:` 分隔的 no such file or directory、connection refused、permission denied 诊断尾部，不能放行私密路径或任意文本。

```text
命令 → 原 backend（连接/缓存/owned child 唯一 owner）→ exit/signal → once close
SSH connect → backend 当前 Client generation（并发复用唯一 promise）→ ready / error / end / close → 清理本次监听
                    ├─ 失败 → 退役 Client → 下一调用创建新 Client；旧事件/TOFU continuation 不改新 generation
                    └─ dispose → 立即 reject → end → 迟到事件不可复活
WSL resolve → 当前身份 promise → 成功缓存 / 失败仅清该 promise
Docker 命令非零 → transportAdapter/probe diagnose → backend 清缓存 → daemon probe → 原因/公开码
SSH 额外验证失败 → shared 公开码/schema → 原 Host 失败快照 → UI 既有错误面板（非补密码）
平台探测/制品目标不支持 → typed error → shared normalize 保留码 → 同一错误面板
```

不新增业务状态所有者、owner/lease 或持久化。Desktop continuous 和 mobile replayable 仍由原 Host registry/attachment 提供，本片仅修正共用 backend 的失败信号；不改变流重放和会话身份语义。

## 验收

先写回归测试并验证修复前失败，再实现：

1. 真实隔离子进程 signal/数字退出码及缺失状态；SSH channel exit/close 顺序、迟到 stdout、一次通知；WSL/Docker 流 signal 非零。
2. 重复 Password 不误判；OTP/中文动态口令在提示文本中可识别；无密码/空提示行为不变；握手与已建立超时文案不同。
3. 在途 SSH connect 后 dispose 不依赖 close/readyTimeout 即 reject；并发等待全部结束；迟到 ready/error 不复活，保留 TOFU 优先级。真实 127.0.0.1 服务交换 SSH banner/KEX 后 FIN、不调用 dispose：首次及重试的并发 waiter 均在 end/close 事件立即失败，每批仅一个 TCP 连接；旧 end 后 close 到达时后继仍可保持 pending 并正常 ready/exec。另以替身覆盖仅 close、同步异常、旧 ready/error/keyboard-interactive/异步 TOFU continuation 不污染后继及成功后去重断连。测试 timeout 仅作失败观察上限，不是生产恢复机制。
4. WSL 身份输出前噪音不污染 distro；命令禁用 profile；列表大小写规范化；非法 user/缺哨兵拒绝且重试重新探测。
5. WSL UTF-16LE stdout 失败原因和退出码；stderr 优先。
6. Docker 失败诊断保留 CLI 文本及公开码；探测失败后可重试、成功缓存会在诊断时失效；普通命令失败且 daemon 健康不被升级成传输错误。
7. F2/F8 原两个 todo 改为真实断言：公开 schema/归一化保留码及不可重试属性，普通认证及 TOFU 不变；Windows probe、Host 不支持目标在制品 IO 前拒绝且不误归 download/preflight。
8. transportAdapter 实际 exec/ensureDaemon、安装 staging/update、probe 非零时确实诊断；daemon 健康保留原失败，异常暴露 daemon 诊断，成功不触发。合成 Docker unix/npipe/tcp 日志与裸路径测试证明不含私密路径且保留 connect errno。
9. UI 既有错误面板展示两个专用原因，中英 key 完整；浏览器场景确认 2FA 不触发补密码入口、普通认证/信任恢复不变。

所有测试仅临时 HOME/XDG/data/workspace；网络仅 loopback；SSH 使用替身或 loopback 服务，不读真实 known_hosts、agent、数据与日志，不连接真实 Docker/WSL。实际执行目标 vitest、root typecheck/lint、目标格式和 architecture check，记录真实失败及环境 Node pin 差异。

## 独立 review 修复：Docker daemon 跨层分类边界

- 根因：`DockerBackend.ensureAvailable` 已确认失败属于宿主 Docker daemon 环境，但只设置 `remote-connection-unknown` 并保留 CLI `cause`；shared normalize 把普通 unknown 当作可下钻包装，沿 cause 的 socket `permission denied` / `connection refused` 又猜成容器文件权限 / 远端主机不可达，覆盖了 backend 的领域判断。
- 唯一分类所有者仍是执行 daemon probe 的 Docker backend；shared 只执行明确的领域边界合同，不根据 Docker/英文错误文案特殊判断。新增共享公开结构端口 `RemoteConnectionDomainError`：`remoteConnectionErrorKind: "domain"` + 有效公开 `code` 表达适配器已完成领域分类。即使 code 是 unknown 也不得被 cause/errors/error 或阶段兜底覆盖；cause 原对象仍保留，供诊断使用。无有效公开码的标记不构成分类事实。
- 未带该标记的普通 unknown/阶段包装继续下钻，仍能识别系统码、文本及专用公开码；既有 TOFU、认证、不可重试规则不变。归一化输出继续脱敏，不能删除 cause 来规避误分类。
- 事件顺序：`adapter.probe → backend.exec → ensureAvailable/probeDockerDaemon → domain error + cause → adapter catch → shared normalize → 原 Error 保留 code/边界/cause`；成功缓存后命令非零则 `adapter/probe → diagnoseExecFailure → 清 availability 缓存 → 同一 daemon probe/分类出口`。不增重试、缓存或连接 owner，不改变 Desktop continuous / mobile replayable 语义。
- 先补隔离回归再实现：真实 DockerBackend、docker-detect、transportAdapter.probe 和 shared normalize 全链路，CLI 子进程仅用合成替身；覆盖首次 daemon 失败、缓存成功后失败诊断，permission denied / connection refused / 非英文原因，断言 unknown、cause 保留、日志正文脱敏，以及无标记 unknown wrapper 仍能提取更具体 cause。再执行相关测试、typecheck/lint/格式/架构检查。不碰 SSH/RPC，不读真实数据日志、不连接真实 daemon、不 commit/push。

### 本次 review 修复验证（区别于下方原轮次记录）

- 已按顺序先更新本 spec、补回归，再实现。修复前两个目标文件共 21 个用例：5 failed / 16 passed；其中真实 backend→adapter 的 permission denied / connection refused 首次与缓存后诊断四例均复现错误改码。修复后 21 passed。
- 本次生产增量仅 `docker-backend.ensureAvailable` 的显式结构标记与 shared normalize 对有效公开码 + 领域标记的优先处理（生产源码净增 11 行）；公开端口、合同说明与示例同步更新。无需修改 transportAdapter；原 Error/cause、缓存失效、连接 owner 和事件顺序不变。普通 unknown 下钻、无效标记、retryable、中文原因及路径脱敏均有断言。
- 临时 HOME/USERPROFILE/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/ZCODE_DATA_BASE_DIR、空 SSH_AUTH_SOCK 下执行：server/shared 排除两个 SSH suite 后 6 文件 88 passed；既有 `remoteBackends.test.ts -t Docker` 为 5 passed / 19 skipped。CLI IO 为替身，未运行真实 Docker，未读真实数据或日志。
- 扩展执行完整 server/shared suite：109 passed / 6 failed，另有 2 个 unhandled rejection；失败来自范围外正在改动的 SSH 测试（remoteBackends 四例、sshBackendLoopback 两例），没有改动 SSH 文件来修复或掩盖失败。
- 实际 `pnpm typecheck` 失败：`packages/rpc/src/channelFailure.test.ts:259` 泛型 Event mock 不兼容，以及 `packages/client/src/diagnosticFactories.test.ts:22/37/64` 使用不存在的 `IFileService.onFileChange`；本片文件未报告类型错误。未修改这些范围外文件。
- `pnpm lint` 通过（0 warnings/errors）；`pnpm architecture:check --changed` 通过（baseline/new 均 0）。本片 7 文件定向格式检查与 `git diff --check` 通过；全量 `pnpm fmt:check` 失败，报告范围外 13 个文件（RPC/client/SSH 测试及其他 spec），未自动格式化他人改动。
- Node 实际 24.19.0，仓库 pin 24.14.0，环境无 mise；未改 pin。未 commit/push。工作区存在其他并发修改，上述结果是本次执行时的真实快照。

## 实现适配与实际验证（协调补齐后）

- 已读取父 spec、本子 spec、architecture skill，并实际运行 source-server/server/ui/desktop context。source-server 受管，其余模块未受管；不改变依赖方向或状态所有者。
- 保留原 worker 的 SSH 单飞/dispose、TOFU 拒绝优先、WSL owned child 与 Docker 前置探测/成功缓存。本轮只补 F2/F8 公开分类、真实诊断消费与日志过滤，不搬运其他上游生命周期或连接 manager。
- 原两个 todo 已改真实断言；新增测试先跑得到 17 个预期失败，再实现。SSH backend 实际连接尝试也断言专用码与 retryable=false；重复密码仍是原认证失败。Windows probe 不再包装丢码，release resolver 在任何制品 IO 前拒绝不支持的平台/架构。
- transportAdapter 的 exec（含 ensureDaemon）、安装 staging/update 与共用 probe 实际在非零退出后调用诊断；成功不探测，daemon 健康保留原命令退出码/原因。顺便修正 update 非 JSON 错误被 JSON 解析异常掩盖的问题，遵循上游文本诊断语义，不增加其他公开码。
- 合成 unix/npipe/tcp Docker 日志、含空格的裸 socket 路径、三种 connect errno、任意尾部过滤和重复脱敏回归通过；没有读取真实用户数据或日志。
- 最终目标测试共 134 passed、0 todo：`vitest run packages/server/src packages/shared/src/source-server --exclude '**/dist/**'` 为 7 文件 98 passed；Desktop config 下 `sourceServerReleaseResolver.test.ts` 为 10 passed；UI config 下 `sourceServerManagementFlow.test.ts`、`sourceServerWizardFlow.test.ts` 为 26 passed。
- `node scripts/ci/source-management-ui-smoke.mjs` 实际 Chromium/loopback 验收通过：新增不支持额外认证、不支持平台、普通认证失败场景；复用既有错误面板，专用中英文 key 完整（单测），浏览器显示专用说明且不自动弹密码表单、不触发确认/成功/隐式重试。保留原安装/目标竞争/身份/凭据隔离场景。
- 所有运行时 HOME/USERPROFILE/ZCODE_DATA_BASE_DIR/XDG 指向新建临时目录，SSH_AUTH_SOCK 清空；浏览器使用已安装 Chromium 二进制但全新临时 profile。真实子进程 SIGKILL 与 127.0.0.1 SSH banner/KEX 回归通过；WSL/Docker 和 daemon 诊断仍为替身测试，未执行真实 WSL/Docker 环境验收。
- 最终 `pnpm typecheck` 通过；`pnpm lint` 通过（0 warning/error）；`pnpm architecture:check --changed` 通过（0 baseline/new violation）；本片文件格式和 `git diff --check` 通过。
- 实际全量 `pnpm fmt:check` 仍失败：范围外 `.agents/specs/upstream-3.17-sync.md` 格式问题，未擅自修改。
- 当前 Node 24.19.0，仓库 pin 24.14.0；未修改 pin。没有修改 rpc、mobile-policy、provider、连接 registry、lock 或其他 agent 的文件，未 commit/push。

## 独立 review：SSH close-only 单飞永久挂起修复

- 生命周期调查依据为本地依赖 ssh2 1.17.0 `lib/client.js`：113–120 行复用 Client 会等旧 close 再 connect；745–759 行收到 banner 后不再产生“无 header”错误；802–829 行 socket end/close 清除 readyTimeout 并发出无 generation 参数事件，close 还清理 Client 当前 callbacks/channel manager。因此仅给复用 Client 的 backend listener 加 generation 不足，采用每次 connect 独立 Client 的最小内部 owner 隔离；backend 仍仅一个 connectingPromise，不增加队列、超时或自动重试。
- 按顺序先更新 F4/spec，再新增真实 loopback 并运行修复前验证：3 测试中原 dispose 通过、新增 2 项失败。FIN 无 error/dispose 后两个 waiter 的失败数组仍为空；另一个用例在旧 close 后仍没有启动后继。测试通过 close 事件和 microtask 观察失败，不依赖等待 readyTimeout。
- 实现由当前 Client identity 绑定常驻 error/end/close、临时 ready、keyboard-interactive 和 TOFU 异步拒绝；共用一个幂等 settle 失败出口。重试退役旧 Client，新 Client 的证据重新归零；TOFU 拒绝优先、fail-closed、dispose 禁止复活、ready 后 keepalive 分类与断连去重均保留。构造参数快照保证重试的凭据/TOFU 目标一致。
- 真实 loopback 验收包含：两批并发 waiter 在 banner/KEX 后 FIN 立即失败、每批仅一条 TCP 连接；真实事件顺序 `旧 end → reject → 新 connect → 旧 close` 后，新连接通过临时生成主机密钥/临时 known_hosts 完成 ready 和 exec。另有替身仅 close/end、同步异常、TOFU 在 error/end/close 的优先级、旧异步 TOFU/额外验证/ready/error、已建立连接重连后旧 close 隔离与断连去重断言。
- 本轮仅修改 `ssh-backend.ts`、`remoteBackends.test.ts`、`sshBackendLoopback.test.ts` 与本 spec；不 commit/push，保留所有其他本地/并行改动。
- 实际完整 server 测试命令 `node node_modules/vitest/vitest.mjs run packages/server/src --exclude '**/dist/**'`：6 文件、95 测试通过；真实 loopback 三项另连续运行 5 轮全部通过，最终再跑完整 server 仍为 95 passed。运行时 HOME/USERPROFILE/ZCODE_DATA_BASE_DIR/XDG 均临时目录，SSH_AUTH_SOCK 清空，仅 127.0.0.1，无真实数据/日志/凭据。
- `pnpm lint` 通过（0 warning/error）；`pnpm architecture:check --changed` 通过（baseline/new 均 0，server 未受管）；四个目标文件 `oxfmt --check` 与 `git diff --check` 通过；`pnpm exec tsc --noEmit -p packages/server/tsconfig.json` 通过。
- 本轮仓库级 `pnpm typecheck` 已执行但失败：范围外 `packages/rpc/src/channelFailure.test.ts:259` 的泛型 Event mock 不匹配，以及 `packages/client/src/diagnosticFactories.test.ts:22/37/65` 的 IFileService 无 onFileChange。以上文件由其他并行工作改动，不擅自修复，不将本轮全量类型检查报告为通过。Node 仍为 24.19.0（pin 24.14.0）。
