# 环境公告（上游 3.18.2 environment announcement）

上游来源：`.cache/upstream-3.18.2` @ `fec97590`：
`core/src/context/sections/env-info.ts`（`buildEnvironmentAnnouncement` / `parseEnvironmentAnnouncement`）、
`core/src/context/sections/desktop.ts`、`core/src/runtime/methods/context-refresh.ts`
（`buildRuntimeContextAnnouncements`）。

CQ5 的审计结论“需要环境快照 owner + 增量公告状态”在本片落实；只移植与本仓**已有 owner** 对得上的部分。

## 1. 为什么需要

F3 prompt 快照冻结了 system 字节：冷恢复后 system 里的 `# Environment` 仍是首次请求的那份。
当同一会话在另一个 Host 配置下恢复（附加目录集合变化、Desktop 呈现面变化），模型看到的环境与
实际执行环境不一致，且没有任何通道告诉它变化。上游把环境从 system 搬到公告通道正是为此。

本仓的取舍：**保留 system 里的完整 `# Environment`（首次请求已经给出全部事实），只把“变化”做成
请求前公告**，避免把整份环境块重复进对话历史。

## 2. 所有者与持久化

| 事实                                | 所有者                                                                       | 持久化                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 已公告的环境快照 + 是否已给过完整块 | `runtime.environmentAnnouncement`                                            | session entry `runtime/environment_announcement`（每会话一行覆盖写） |
| 已发出的增量公告正文                | append-only 历史（synthetic user notice，source `environment_announcement`） | 普通消息持久化                                                       |

写入路径只有一条：请求前比较 → 落库公告 → 更新 session entry。没有第二个消费者写同一行。

```text
resume → loadEnvironmentAnnouncement(session entry)
      → 首次请求：快照 == system 渲染 → 只记录基线，不发正文
      → 之后每请求：diff(previous, current) → 有变化则追加一条公告 → 覆盖写 state
```

## 3. 快照形状

`{ cwd, platform, shell, osVersion, isGitRepository, additionalWorkingDirectories[],
desktopContext?, visualizationDirectory? }`

当前值来源：`runtime.config.envInfo`（Context Source 初始化后写入）、`runtime.workingDirectory`、
`runtime.config.additionalDirectories`、`runtime.config.presentationSurface === "zcode_desktop"`、
`resolveGenUiOutputDirectory(runtime)`。不重新探测 git/平台。

## 4. 公告正文

- 无基线，或 platform / OS 版本变化 → 完整 `# Environment` 正文（`buildEnvInfoContent`）。
- 否则 `# Environment update` + 逐项变化行：
  `Primary working directory`、`Is a git repository`、`Additional working directories added/removed`、
  `Visualization directory for this session`、`Shell`（含 `(was …)`）。
- Desktop 段按写法比较：写法不同 → 追加新段；离开 Desktop → 追加
  `The ZCode Desktop Context above no longer applies…`。
- 没有变化 → 不产生任何 entry（不重发、不改字节）。
- 新会话首个环境块额外带 untrusted downloads 说明（与上游同一条文案）。

## 5. 不移植的部分（明确）

| 上游项                      | 本仓处置                                         | 依据                                                                             |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| 环境块搬到 `meta_user` 公告 | 不搬                                             | 本仓 system 由 prompt 快照冻结，搬走会让首次请求少一块稳定上下文并改变已发布字节 |
| 每请求探测 git / OS         | 不搬                                             | 会重复 IO，且与 prompt 快照“快照时事实”冲突                                      |
| Gen UI 目录自动创建         | 已有 owner（`ensureGenUiOutputDirectory`），不改 | 不是公告职责                                                                     |
| 手机/远端频道               | 沿用既有语义                                     | 公告随会话历史走，端上不重建                                                     |

## 6. 失败语义

- session entry 读失败/无效 → 当作没有基线：首个请求只记录基线（不阻断 resume，也不重复整块）。
- 公告写库失败 → 错误向上冒泡（与本仓其它公告一致，不能“发了但没记”）。
- entry 写失败 → 只记 warn，下次请求重新比较（最多重复一条增量，不丢内容）。

## 7. 验收

1. 纯函数：无基线 → 不发正文；目录增删 → 只出现 added/removed 行；Desktop 写法变化 → 追加段；
   无变化 → `null`。
2. 真实 SQLite + loopback：会话 A 以目录 `[d1]` 跑一轮；恢复 runtime 用 `[d1, d2]` 再跑一轮 →
   第二轮请求体含 `Additional working directories added: d2`，且 system 与第一轮逐字节相同；
   第三轮无变化 → 不再出现公告行。
3. 负向：entry 数据损坏 → 恢复不失败，下一请求只记录基线。
