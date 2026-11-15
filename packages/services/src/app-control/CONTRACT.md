# app-control

Desktop Host 侧 App 会话控制：把 `appControl/*` 十二个封闭意图映射到既有 owner。

- 委托 owner：项目/任务（`IProjectService`、`IZCodeTaskService`）、会话正文（`IZCodeAgentService.readSessionMessages`）、
  导航（Desktop 窗口 Host 的 `AppControlNavigationPort`）。本模块不持第二份项目、会话、队列或导航状态。
- 连接事实：`AppControlBinding` 只由 Host 的活跃 CLI 连接构造；`assertCurrent()` 只核对连接代际。
- 跨 Host：`sourceServerId` 不匹配、会话不在本 Host 目录快照、项目来源不一致一律 `forbidden`。
- `openSession` 只按绑定窗口路由；没有导航 owner（手机/Web/远端）时明确 `unavailable`。
- `forkSession` 只在 `readConversationRows` + `forkAssistant` + `reserveFork` 三个真实端口都在场时
  进入 `availableActions`。它把 `ReadSession(view=messages).id`（transcript messageId）显式映射到
  V4 投影的 `{rowId, entityId}`，用同一次快照的 `revision/logEpoch` 发送既有 CLI `forkAssistant`；
  子会话归属仍由项目仓储 `reserveCreatedTask` 预留。父会话忙、边界过期、Host 换代、未知 ACK 与
  预留失败分别按 rejected/unknown 收口，不伪造 created，也不删除已创建目录。
- 旧 Agent（端口缺失或 runtime 不识别 v4 forkAssistant）明确 `unavailable`；未新增第二 runtime、
  fork store 或 accepted 队列。
- 十二个意图：listProjects / listSessions / readSession / createSession / forkSession / sendToSession /
  waitSessions / interruptSession / renameSession / openSession / setSessionArchived / setSessionPinned。
- 幂等身份：create/fork/sendToSession 的 commandId 一律是 `appControlCommandId(callerId, requestId)`，
  按调用方命名空间隔离；两个插件/调用者对同一会话提交相同 requestId 也是两条命令。
- 观察：`waitSessions` 的 initial 必须是 owner 的真实 owner 快照（读一次 task meta / live 执行），
  不能用合成的 revision 0/unknown——否则 wait 会在第一份 baseline 上直接判定 unknown 并返回。
