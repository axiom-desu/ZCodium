# Upstream 3.18.2 extension host / slots port

## Scope and source

Port the actual upstream `packages/plugin-api`, shared extension protocol, services extension gateway/grant store/context-generation pumps/view relay, Desktop extension-host process supervisor, and UI extension slots into the existing window-scoped Local Host path. Source is `.cache/upstream-3.18.2` at `fec97590`; adapt to local public contracts rather than bulk-copying upstream indexes or large entrypoints. Preserve upstream licenses/NOTICE and record modifications. Do not restore excluded auth, telemetry, cloud-only dependencies, or strong-account-bound services.

## Ownership and request path

```text
Renderer extension slot → window-scoped Local Host IExtensionsService
   → services/extensions (single capability/grant/static-table owner)
   → Desktop Main supervisor (single extension process lifecycle owner)
   → extension process

Capability call → gateway (declaration + protocol + grant + generation fence)
   → existing Local Host service / CLI owner → result revalidated against grant + generation
```

The extension subsystem is not a task/session/runtime owner. Reuse the existing Local Host, Session Control and plugin management; do not introduce another accepted queue, runtime, or remotely reachable extension service. The extension process is Main-supervised and window scoped; renderer slots are projections, never authorities.

## Security and lifecycle invariants

- Capabilities default deny. A call is admitted only when declared, protocol-compatible, and covered by explicit user approval. Revocation and grant-file write failure are atomic with respect to published state; revoke aborts in-flight work. Approval is per plugin and only covers currently declared grants.
- Every process connection, view, capability call, contribution update and renderer acknowledgement is fenced by workspace identity/scope and process generation. Stale responses cannot affect a replacement generation or workspace. Revocation is rechecked at completion.
- Manifest validation is strict and bounded; no untrusted HTML/SVG/styles. Process environment uses an explicit allowlist; process restart/crash budget and shutdown/cancel behavior are explicit.
- Desktop continuous and web/mobile replayable attachment semantics remain distinct. Extensions are local-desktop only: preserve S1 method allowlists and #92 layout/navigation; do not expose extension services to phone/web remote.
- Slot values are projections from the one services owner and current process contribution snapshot. No duplicate accepted state or renderer authority.

## Integration boundaries

- `@zcode-dev/plugin-api` is a private workspace package, not an npm publication task.
- New shared/services/UI modules require managed module manifests and module contexts; root package/lock/policy and generated G1 integration are owned elsewhere and must not be edited by this task. Keep any integration request explicit if those changes block validation.
- Window Local Host registration is the only service-registration path. Main owns only process/window lifecycle. UI attaches to the original window Local Host navigation surfaces.

## Acceptance scenarios

1. Unapproved and undeclared capabilities reject without calling their backing service; after approval only declared capability/protocol works.
2. Revocation blocks subsequent calls, cancels in-flight calls, and stale completion cannot publish results.
3. Stale generation/workspace view requests, contribution patches, and acknowledgements are ignored/rejected.
4. Actual child-process stdio lifecycle covers launch, readiness, crash/restart budget, cancellation, graceful shutdown and kill fallback.
5. Local loopback view relay validates allowed methods and rejects remote/mobile exposure.
6. Real UI component tests cover each new slot integration, empty/stopped states, navigation, and no extension UI for mobile/web.
7. Preserve existing S1 allowlist tests and #92 layout/navigation tests; verify no second accepted/runtime business owner.

## 7. 实现范围（E5）

已落的模块（均按 `architecture-policy.yaml` 精确注册，不改基线/忽略项）：

```text
Renderer ExtensionStatusSlot → extensionsService（RPC 投影）
  → shared/extension-host（清单/能力/授权/槽位/帧/SDK）
  → services/extensions（授权文件 + 能力网关 + 槽位投影 + loopback）
  → Main extensionHost supervisor（stdio 生命周期）→ 扩展子进程
        └── loopback 能力调用 → Host 现有服务（settings / project）
```

- `@zcode-dev/plugin-api` 为 private workspace 包，不发布 npm；仅导出本仓已实现的能力类型。
- 能力表本切片只含 `settings.get`、`projects.list`（`projects.read`）、`context.get`；未实现的能力不存在，
  清单声明会被拒绝，而不是静默降级。
- 扩展 UI 只有 `status.composer` 一个真实槽位，挂在侧栏页脚；无扩展服务（手机/Web/旧 Host）返回 null。
- 扩展服务只注册在窗口本地 Host；未加入任何附件白名单，`desktop-continuous` 完整服务面不变。

## 8. 实现范围（E6 安全与生命周期加固）

E5 的 loopback 只有一个共享 token、一个进程加载全部插件，网关只校验 token 不绑定 `pluginId`：
任一能发请求的插件可以声称另一个已授权插件。E6 修正为「认证身份 = 插件身份」：

```text
插件 A 进程（仅 A 的 token/目录/manifest）── Authorization: Bearer A ──┐
插件 B 进程（仅 B 的 token/目录/manifest）── Authorization: Bearer B ──┤
                                                                        ├→ loopback
 token → pluginId（服务内唯一绑定）→ 请求体 pluginId 必须相等 → gateway
```

### 8.1 传输身份与凭据

- Bearer token 是唯一身份来源。每个插件独立 token，`services/extensions` 持有 `token → pluginId`；
  请求体不再携带 token，只带被校验的 `pluginId`。身份不匹配一律 `unauthorized`。
- 每个插件由 Main 单独拉起子进程，环境只含自己的 `pluginId`、目录、endpoint 与代际；
  不向任一插件传递 peer token，也不再把 `pluginDir` 交给 worker 自行扫描。
  token 的传输方式见 §9：不写环境/argv，只经 stdin 一次性 bootstrap 帧。
- 同用户 Node 插件没有 OS sandbox。独立进程与 token 绑定是归因/准入边界，不是 OS 隔离；
  文档和 UI 不得把 grant 说成 OS 隔离或跨插件内存隔离。

### 8.2 激活同意

- 发现 ≠ 激活。没有用户同意记录的插件不加载 `main`、不启动进程；
  `grants.json` 中一条记录（即使插件声明零档位）就是运行同意。
- worker 只读取 env 指定的单个插件目录与 `extension.json`，校验 `manifest.id === pluginId` 后加载
  `manifest.main`；不再扫描发现目录里的其他 JS。
- 撤销会失效该插件 token 并停止其进程；贡献与能力调用都复检同意状态。

### 8.3 生命周期顺序

```text
start  → 加载清单 → generation+1 → 开 loopback → 仅对已同意插件逐个子进程 start → ready
grant  → 校验声明一致 → 原子写 grants.json → 发布 → 若 Host ready 则启动该插件进程
revoke → 取消在途 → 失效 token → 停止该插件进程 → 原子写成功后才发布撤回快照
stop   → 取消全部在途 → 失效全部 token → 关 loopback → 停止该代际全部进程 → 清空槽位
```

- start/stop/grant/revoke 由唯一生命周期队列串行；stop 在 startup 期间到达时，start 在下一个
  检查点退出并清理，不留下迟到的 ready 进程。
- supervisor 按 `(window, pluginId)` 持有进程；同键并发 start 串行，停止中的进程不重启；
  启动超时、握手失败、被替换的迟到 child 都会 kill 并清理，不覆盖新代际。
- 撤销落盘失败不发布撤回成功：运行时 token 已失效（fail closed），持久化与投影保持上一次成功状态。
- workspace identity 变化时立即清空旧槽位、失效旧凭据并停止旧代际进程；旧 endpoint 不再可用。
- loopback 关闭会断开挂起连接，hanging close 有上限；handler rejection 被转换为 500，不产生
  unhandledRejection。
- 手机/Web 仍不创建 Extensions 代理、不注册频道；桌面本地 base attachment 才提供扩展投影。

## 9. 实现范围（E7 凭据分发与启动失败收口）

E6 的 per-plugin token 绑定正确，但 token 通过子进程环境变量下发（`ZCODE_EXTENSION_HOST_TOKEN`）。
同用户进程可读 `/proc/<pid>/environ`（或等价方式）拿到 peer token，再用它冒充已授权插件。
E7 把“凭据分发”与“操作系统隔离”分开：本轮只保证不经 API/环境变量分发 peer credential。

### 9.1 凭据分发

```text
Host services/extensions 生成 token（token → pluginId 唯一绑定）
   → Main supervisor start(input.token)          ← 只在 Main 内存，不写 env
   → child stdin 第一行一次性 bootstrap 帧          ← 私有管道，读后即消耗
   → worker 解析后仅保存在内存，交给 SDK
   → ready / log / error / stdout 均不回显 token
```

- `EXTENSION_HOST_ENV` 不再包含 token；`buildExtensionProcessEnv` 不写任何凭据。
- bootstrap 帧严格校验且只接受一次；首帧之前收到 shutdown/非法帧按启动失败处理。
- 同一用户 Node 插件没有 OS sandbox。本边界是“不通过 API/环境分发 peer credential”，
  **不是**防御恶意同 UID 进程直接读取其他进程内存/`/proc`；文档与 UI 不得承诺 OS 隔离。

### 9.2 激活失败

```text
worker main() 失败（manifest/main/activate 抛错）
   → 严格 error 帧（不含 token/凭据）→ exit != 0
   → supervisor waitReady 收到 error 即拒绝 start，kill 并移除该 (window, pluginId)
   → Host startInternal catch → abortStart：清 token、关本代 loopback、停本代进程
   → phase = error 并发布；旧代际/其他插件进程不受影响
```

- 激活失败不得先发 `ready`：用户插件异常不能显示成“已运行但无贡献”。
- 失败帧是有界 `{type:"error",message}`；supervisor 只在 ready 之前把它当启动失败，
  ready 之后的 error 仍是运行期告警。
- 只有 error 帧而进程未退出时，start 也必须立即失败并清理，不能等满启动超时。

### 9.3 激活同意

- 首次运行（含声明零档位）必须有 `grants.json` 记录；`resolveGrantState` 是唯一判定入口，
  无记录即 `needs-consent`，不加载 `main`、不 spawn。空档位 `grant({grants:[]})` 是明确的运行同意。
- UI 授权区必须写明：扩展以当前用户权限运行第三方 Node.js 代码，启用不提供操作系统级隔离，
  同意后才启动。

### 9.4 验收

- 真实 child process：token 不在 env、只在 bootstrap 帧；ready/log/error/stdout 不含 token。
- 真实 child process：激活抛错 → start 拒绝、phase=error、本代进程与 loopback 清理，
  随后启动其他插件成功。
- 复验：stop during start、revoke、无响应 child 的 kill 兜底、peer body spoof、
  零档位插件同意前不激活 / 空档位同意后激活。

## Status

Implemented in E5, hardened in E6 and E7. Acceptance evidence:

- `packages/desktop/test/extensionHostSecurity.test.ts`：真实双插件 stdio/loopback，独立凭据、
  A token 声称 B 身份被拒、未同意插件不激活、撤销停止单插件、start/stop 并发与挂起 close。
- `packages/desktop/test/extensionHostIntegration.test.ts`：真实子进程 stdio + loopback，
  同意前只发现不启动 → 授权后调用现有 project/settings 服务成功 → 撤销后进程停止、槽位消失、
  旧 token 401 → 非 token 与带 `Origin` 的请求 401 → 停止后旧 endpoint 拒绝连接。
- `packages/desktop/test/extensionHostSupervisor.test.ts`：环境 allowlist、崩溃重启预算、
  过期代际/单插件停止、同插件并发 start、startup 中断与握手失败清理。
- `packages/services/src/extensions/app/gateway.test.ts`：默认拒绝、过期代际/工作区、
  A 凭据声称 B 身份被拒、撤销后贡献拒绝、撤销取消在途与迟到结果复检。
- `packages/services/src/extensions/adapters/service.test.ts`：授权/撤销落盘失败不发布成功，
  撤销运行时 fail closed。
- `packages/client/src/remoteServiceAccess.extensions.test.ts`：远程/手机默认不创建 Extensions 代理。
- `packages/ui/test/extensionStatusSlot.test.tsx`：真实槽位组件渲染、待授权启用/撤销、手机/Web 不渲染、旧代际隐藏。
- `packages/desktop/test/extensionHostActivationFailure.test.ts`：真实子进程，零档位插件同意前不激活；
  激活抛错 → phase=error、本代进程/loopback 清理；随后启动新实例成功，旧代际不影响新实例。
- E7 补充到 `extensionHostSupervisor.test.ts`：token 只经 stdin bootstrap、env 无 token、
  ready 前 error 帧拒绝启动、无响应 child 的 kill 兜底。
- 结果与剩余接缝见 `/tmp/sync318-E6-result.md`、`/tmp/sync318-E7-result.md`。
