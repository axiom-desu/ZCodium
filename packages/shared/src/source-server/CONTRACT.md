# source-server

SourceServer/R3 的纯 domain 契约：Profile、更新授权目标、workspace 迁移报告、连接状态快照、
发布描述符、产品兼容性、错误分类与连接日志脱敏。

- 只有握手（经过鉴权）才能产生 `sourceServerId`；路径、hostname、route 输入不能当身份。
- `sourceServerUpdateRequestSchema.expectedTarget` 绑定执行身份；`force` 只表达忙碌许可，
  不改变 target/artifact/integrity 校验。
- 凭据只以 `*CredentialKey` 形式出现在契约里；schema 不接受密码/私钥/passphrase 明文。
- `evaluateSourceServerCompatibility` 要求较旧产品版本 >= 较新端的 `minCompatibleVersion`，
  不提供“缺失即兼容”的宽松回退；调用方必须显式传入双方 manifest。
- `remote-authentication-unsupported` 只表达服务器明确要求当前不支持的额外认证；不能当作缺少密码恢复。`remote-platform-unsupported` 表达平台/制品架构不支持。两个公开码均不可自动重试，归一化不得改成 preflight/download；其余认证、TOFU 与恢复分类不变。
- `RemoteConnectionDomainError` 是适配器到 shared normalize 的公开结构端口：有效公开 `code` 与 `remoteConnectionErrorKind: "domain"` 表示已确认的领域分类（含 unknown），阻止内层 cause/errors/error 或阶段兜底改码；不删除或改写原始 cause。不带标记的 unknown/阶段包装仍提取更具体原因，标记缺少有效公开码时无效。Docker daemon probe 使用该边界，不按错误文本判断领域。
- `connectionLog` 输出用于用户可见日志与反馈附件；调用方负责把已知秘密显式传入。Docker unix/npipe/tcp URL 与裸 socket 路径必须脱敏，明确 connect errno 可保留。
- 本模块不进行 IO，不保存状态，不创建进程；持久化与 transport 由上层 owner 承担。
