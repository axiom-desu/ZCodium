# bot-topic-resource

`ReadTopicResource` 在 Host 侧的唯一实现面。官方语义见 `.cache/upstream-3.18.2`
（`packages/services/src/bots/topicResource.ts`、`bots/topic-history-attachment/*`），
本仓差异与验收见 `.agents/specs/upstream-3.18-t5-topic-resource.md`。

- 公开面：`../../bots/topicResource.ts` 的 `authorizeTopicResource` / `readAuthorizedTopicResource`，
  `../../bots/topicArchive.ts` 的 `BotsTopicArchive`，签名见 `contract.ts`。
- 状态所有者：`BotsTopicArchive`（`bots-topic-archive.json`）。只有 bot 入站真实接纳
  （`admission=accepted`）才写入；`generation` 单调递增；缩容与过期只在 `admit` 内发生。
- 读取：`taskId` + workspace 身份 + `inputId?` + `messageId` + `resourceIndex` 必须命中同一快照；
  下载前后各复核一次授权指纹（bot/provider/凭据/群），任一变化即失败。
- 下载只走已配置 provider（当前 `feishu`/`lark`）的原 bot 资源能力：校验资源键、大小上限、
  重定向域与取消；字节只在内存中回传 Host 反向 RPC，不落用户路径、不新建登录。
- 错误：未接纳、跨任务、越界索引、provider 不支持、大小超限、授权换代、取消，一律拒绝。
