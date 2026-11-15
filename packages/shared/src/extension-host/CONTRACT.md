# extension-host-protocol

纯 domain 模块，零 IO、零宿主状态。持有扩展清单 schema、能力表、授权档位、槽位贡献投影、
loopback/stdio 帧 schema 与扩展侧 SDK 类型。

## 不变量

- 能力表是唯一定义：表里没有的能力不存在；清单声明未知能力按 `unknown-capability` 拒绝，
  能力所需档位未在清单 `grants` 里声明按 `undeclared-grant` 拒绝。
- 会话能力（`sessions.*`，十二个）的入参与返回直接引用 `@zcode/session-control/contracts`
  的 canonical App schema（与模型会话控制工具同一份定义）；本模块不复制、不改写这些 DTO。
- 档位链：`sessions.write` 包含 `sessions.read`；`grantsCover`/`normalizeGrants` 是唯一判定。
  四项读要 `sessions.read`，八项写要 `sessions.write`；协议名 `sessions` v1 显式协商，不符报
  `incompatible`。
- 清单严格有界：schemaVersion=1、`id` 为小写 slug、`main` 只能是同目录单层文件、
  能力 ≤32、档位 ≤16、槽位 ≤16、标题 ≤80，未知键拒绝；不接受 HTML/SVG/URL/样式。
- 槽位只接受固定枚举（`navigation.primary` / `status.composer`）与固定图标名；
  Renderer 只渲染宿主内置组件，贡献数据不进入 DOM 属性。
- 授权默认拒绝：没有记录、记录与当前清单声明不一致、或代际/工作区不匹配都按未授权处理；
  `grantsCover` 是唯一覆盖判定。
- 每帧都携带 `generation` 与 `workspaceIdentity`；任一不匹配即 `stale-generation` /
  `workspace-mismatch`，旧代际结果不能写回。身份只来自已认证的 Bearer token：请求体的
  `pluginId` 必须等于该 token 在服务内绑定的插件，否则 `unauthorized`；请求体不携带 token。
- 扩展进程环境只从 `EXTENSION_HOST_ENV` 显式 allowlist 读取；环境里没有 token。
  每个插件子进程只收到自己的 endpoint/generation/workspaceIdentity/pluginId/目录，不继承整份宿主环境。
- 凭据只经继承的 stdio 私有管道第一帧（`bootstrap`）一次性下发；worker 读取后即消耗，
  ready/log/error/stdout 不回显 token。该边界是「不经 API/环境变量分发 peer credential」，
  不是操作系统隔离，也不承诺防御恶意同 UID 进程直接读取其他进程内存或 `/proc`。
- 激活失败必须经严格 `error` 帧上报并以非零码退出；未成功加载 `main` 的进程不能发送 `ready`。
- 能力名、协议名与版本号由本模块给出；`services/extensions` 只能按表实现后端，不能自建能力。

## 边界

- 授权、槽位投影与 loopback 服务器的唯一 owner 是 `services/extensions`。
- 扩展进程生命周期的唯一 owner 是 Desktop Main 的 supervisor。
- Renderer 只消费 `services/extensions` 的投影；不持有授权或贡献状态。
