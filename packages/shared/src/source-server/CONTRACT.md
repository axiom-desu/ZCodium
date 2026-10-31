# source-server

SourceServer/R3 的纯 domain 契约：Profile、更新授权目标、workspace 迁移报告、连接状态快照、
发布描述符、产品兼容性、错误分类与连接日志脱敏。

- 只有握手（经过鉴权）才能产生 `sourceServerId`；路径、hostname、route 输入不能当身份。
- `sourceServerUpdateRequestSchema.expectedTarget` 绑定执行身份；`force` 只表达忙碌许可，
  不改变 target/artifact/integrity 校验。
- 凭据只以 `*CredentialKey` 形式出现在契约里；schema 不接受密码/私钥/passphrase 明文。
- `evaluateSourceServerCompatibility` 要求较旧产品版本 >= 较新端的 `minCompatibleVersion`，
  不提供“缺失即兼容”的宽松回退；调用方必须显式传入双方 manifest。
- `connectionLog` 输出用于用户可见日志与反馈附件；调用方负责把已知秘密显式传入。
- 本模块不进行 IO，不保存状态，不创建进程；持久化与 transport 由上层 owner 承担。
