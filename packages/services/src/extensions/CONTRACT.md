# extension-host-service

窗口本地 Host 的扩展服务：授权记录、能力网关、槽位投影与 loopback 服务器是唯一 owner。
Desktop Main 只拥有扩展进程生命周期（start/stop/重启预算）；Renderer 只消费投影。

## 事件顺序

```text
start()  → 加载清单 → generation+1 → 开 127.0.0.1 loopback → 仅启动已同意插件 → ready
grant()  → 校验声明与请求一致 → 原子写 grants.json → 发布 → Host ready 时启动该插件
revoke() → 取消该插件在途 → 失效 token → 停止该插件进程 → 写文件成功后才发布
stop()   → 取消全部在途 → 失效全部 token → 关 loopback → Main 停止该代际进程 → 清空槽位
```

## 不变量

- 默认拒绝：无记录、声明与记录不一致、插件升级（consentVersion 变化）都按未授权；
  `grant` 只接受与当前声明完全一致的请求，过期对话框值不会被部分写入。
- 发现不等于激活：没有用户同意记录的插件不加载 main、不启动进程；空档位记录同样是运行同意，
  UI 必须明文说明扩展以当前用户权限运行第三方 Node.js 代码、启用不提供 OS 级隔离。
- 激活失败（manifest/main/activate 抛错）经严格 `error` 帧上报并非零退出；supervisor 拒绝 start，
  Host 进入 `phase=error` 并清理本代 token、loopback 与进程，旧代际/其他插件不受影响。
  不得在激活失败后发送 `ready`。
- 每个插件独立 token，服务持有 `token → pluginId` 唯一绑定；loopback 只从 Authorization 头取身份，
  请求体 `pluginId` 必须与认证身份一致，A 的 token 不能声称 B。
- token 不经子进程环境变量分发：Main 只把当前插件 token 放在内存，经 stdio 第一帧
  `bootstrap` 交给 worker，worker 读取后即消耗；ready/log/error/stdout 不回显 token。
  同用户 Node 插件仍无 OS sandbox，本边界是不经 API/环境分发 peer credential，
  不是防御恶意同 UID 进程，也不等于 OS 隔离。
- 每一次能力调用依次核对认证身份 → generation → workspaceIdentity → 同意/授权 → 清单声明 → 协议
  → 后端；调用返回时再核对一次，撤销/换代后的迟到结果不写回，signal 已 abort 时永不发布结果。
- 会话能力（E8）以客户端类调用方复用既有 `AppControlService.bindClient` 的十二个 App 意图：
  不新建 session/task owner，不直接读 Repo 或操作 runtime；`clientId=extension:<plugin>` 只做归因，
  `connectionId=extension-host:<generation>:<plugin>` 是 fence。没有装配 App 控制的 Host 返回
  `host-unavailable`，不降级为直接读库。session-control 的 `forbidden`/`unavailable`/`conflict`/
  `invalid_input`/`cancelled` 按名映射为扩展错误码，其它后端错误只报固定文案。
- 会话写动作的幂等身份由 App control 按 `(callerId, requestId)` 生成，`callerId` 含插件身份；
  两个插件对同一会话提交相同 `requestId` 是两条命令，同插件重放才命中同一命令。
- `canceled` 只表示调用结果未交付（撤销/停止/换代），不代表后端未执行：迟到的 mutation ACK
  不能反向宣称「未执行」；写操作需要重试时仍用同一 `requestId` 对账。
- 授权请求必须与当前规范化声明完全一致；声明从 read 变 write（或新增档位）回到 `needs-consent`，
  不会因为旧记录而隐式放宽。授权前不加载插件代码、不启动进程。
- 撤销先取消在途、失效 token 并停止该插件进程，再落盘；落盘失败不发布撤回成功，
  运行时保持 fail closed，持久化与投影保留上一次成功状态。
- loopback 只绑定 127.0.0.1，拒绝非回环来源、带 `Origin` 头的请求与未知路由；
  请求体上限 256 KiB；关闭时断开挂起连接，handler rejection 转为 500。
- 扩展不暴露到手机/Web：远程/手机不创建 Extensions 代理，本服务不进入任何附件白名单。
- supervisor 按 `(window, pluginId)` 持有独立进程；同插件并发 start 串行，停止中不重启，
  启动超时/握手失败/迟到 child 都清理，不覆盖新代际。
- 同用户 Node 插件没有 OS sandbox；独立进程与 token 绑定是归因/准入边界，不是 OS 隔离。
- 槽位是整份快照，不做增量补丁；只接受清单声明的槽位 id，撤销后的贡献不能重新写回。
- 清单发现阶段不执行插件代码；无效清单只记录目录名与原因码。
