# 上游 3.18.2 数据同步（D1）：配置分类同步、设备同步状态、Provider Provisioning lane

- 上游来源：`zai-org/ZCode@fec97590`（3.18.2），区间 `3c5b2276..fec97590`。
- 目标切片：`/tmp/sync318-services-inventory.md` A1–A4（S1 范围）。
- 参考（只读）：`.cache/upstream-3.18.2/packages/services/src/data-sync/**`、`provider-provisioning-status/**`、`shared/src/{remote-sync,mcp-sync,skill-sync,plugin-sync,provider-provisioning}.ts`。
- 不在本切片：设置页同步 UI（U1）、远端设备生命周期/bind flight（R1/S3）、project/purge（S2）、遥测/off-peak/highspeed/CUA 休眠（本仓已移除，不恢复）。

## 唯一所有者

| 状态                                               | 唯一所有者                                                                               | 说明                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 各分类条目内容（MCP/技能/插件/子智能体/命令/钩子） | 本机 `~/.zcodium-exp`（或既有服务路径）配置文件                                          | 同步服务只做「写前重读 → 只改选中字段 → 原子替换」，不持有缓存 |
| 分类服务方法面                                     | `mcp-sync` / `skill-sync` / `plugin-sync`（五方法）+ `user-config-sync`（category 分派） | 每个通道只有一个服务实例，同时承载旧归档同步适配方法           |
| 设备同步状态                                       | 桌面本机 Host `IDeviceSyncStateService`（`<appConfigDir>/data-sync-state.json`）         | 不进远程 RPC 合同、source-settings 集合、手机白名单            |
| Provider Provisioning lane 状态                    | Main `ProviderProvisioningEnvironmentCoordinator`（内存）                                | Host 服务只做 `read/wait/retry` 请求转发，不缓存、不持久化     |
| 手机/Web 授权                                      | `windowHostAttachmentRpcPolicy` 显式 allowlist                                           | 新通道默认拒绝；mcp-sync 只放行设置读写三方法                  |

## 事件顺序

```text
Renderer ─RPC─▶ 分类服务 list/getHashes/checkAccess ─▶ 本端配置（只读）
Renderer ─RPC─▶ exportSyncItems(keys, workspace?) ─▶ 来源端字节/归档（不落盘）
Renderer ─RPC─▶ importSyncItems(payload, items[{mode, expectedTargetHash?}])
   └─▶ 写前重读 ─▶ 逐项校验(路径/key/CAS) ─▶ 原子替换 ─▶ 返回 results[]
                    └─ createOnly 已存在 → conflict（不写）
                    └─ overwrite 哈希不一致 → conflict（不写）

数据同步页设备行 ─RPC─▶ host deviceSyncState.getDeviceSyncStates（只本机）
推送结束 ─RPC─▶ host deviceSyncState.recordDeviceSyncResult（Host 内串行 + 原子替换）

Renderer ─RPC─▶ host providerProvisioningStatus.getStatus/retry
  └─▶ HostResponse provider-provisioning-lane-request{requestId, action, sourceServerId}
        └─▶ Main 协调器 lane（single-flight drain；retry 只推进同一 lane 的尾随代际）
              └─▶ HostMessage provider-provisioning-lane-result{requestId, status}
```

顺序约束：

- `importSyncItems` 先做包含关系检查（父目录覆盖会改写/删除子条目），再做 CAS 哈希校验；两者都不通过时不写文件。
- 目录类覆盖在同盘临时目录解压 → 原目录改名备份 → 新目录改名到位；任一步失败还原，还原失败保留临时目录并写明位置。
- 技能父子嵌套按来源目录层级先上级后下级处理；下级在本次已写入的上级之内时随上级写入。
- 首次上线 drain 与 `user-retry` 共用一条 lane；重试在首次失败后仍会执行自己的代际（不返回上一代的结果）。
- lane 查询永不抛错：Main 对每个 requestId 都回应，缺协调器时回 `{ lane: "none" }`。

## 不变量

- 推送永不删除目标端独有条目；只处理 `items` 列出的 key。
- `overwrite` 必须带 `expectedTargetHash`，目标端导入前重算；`createOnly` 目标端已有同 key 即 conflict。
- 启用状态：新建项写来源状态（来源启用时删除目标端残留 disable），更新项保留目标端状态。
- MCP：目标端实际生效 `~/.agents/mcp.json` 兼容配置时整类拒绝导入；来源端按目标 home/workspace 改写路径后再算哈希。
- 路径：来自对端的相对路径只允许普通片段；越界、`.`/`..`、绝对路径、盘符、反斜杠一律拒绝。
- 软链：来源目录含内部软链不能导出；目标是软链或 `~/.agents` 兼容目录时不能覆盖。
- 唯一目录：inline 插件新建首选目录被占用时退到带短哈希后缀的目录，不覆盖已有内容；`data/` 不导出、不参与哈希、覆盖时保留目标端。
- 设备同步状态只在本机 Host，不暴露给远端或手机；Provider lane 只以 Main 内存 lane 为权威，不持久化。
- 手机/Web 的 `mcp-sync` 仍只放行 `loadMcpFromUserDirectory` / `saveMcpToUserDirectory` / `listWorkspaceMcpServerStatuses`；五个数据同步方法与 `user-config-sync` / `device-sync-state` / `provider-provisioning-status` 一律拒绝。

## 失败语义

| 场景                                       | 结果                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| CAS 哈希不一致 / createOnly 已存在         | 该项 `conflict`，不写文件                                       |
| 路径非法、名称与 key 不符、归档缺 manifest | 该项 `failed`，写明原因                                         |
| 目标目录含其他条目                         | 该项 `failed`（先于哈希检查），目录不动                         |
| 配置文件损坏（JSON 无效）                  | 写入路径抛错 → 整次导入项全部 `failed`；只读展示按空配置/未同步 |
| 旧 Agent 缺方法                            | RPC `method-not-found` 向上抛出，不当作成功                     |
| 手机/Web 请求新通道                        | `feature_disabled` / Unknown channel                            |

## 与上游的差异（有意）

1. 旧归档同步方法（`listLocal*Candidates` / `export*` / `import*` / `checkRemote*WriteAccess`、marketplace 镜像）仍由同一服务实例提供：设置页同步弹窗是真实调用方，删除会造成功能回退；新入口只使用五方法契约。
2. `user-config-sync` 未加入本仓 `assertLegacyRemoteWorkspaceRpcContract` 的必需列表：旧 3.17 Server 仍可连接，缺该方法时调用得到 method-not-found，不被视为成功。
3. `provider-provisioning` envelope 仍为 v2（personal config）：v3 的 account settings/credentials 与 Target 写入拒绝语义属 provider 面 owner，未在 D1 推进；lane 只新增状态投影与 `user-retry` 触发源。
4. `data-sync` 未注册为独立受管模块（`architecture-policy.yaml` 由整合方维护）：新增文件落在既有 `services` 模块根下，层方向与 `services` 一致；未引入新的跨模块边。
5. `subagentDataSyncState` 内含 `collectAgentMarkdownPaths` / `normalizeBuiltInSelectionOverrides` 的等价实现：`subagentsService` 不在 D1 可改范围，未放宽其导出面。

## 验收

- 自动化：`packages/services/test/dataSync.test.ts`（CAS 覆盖/conflict、设备状态串行与损坏文件、目录软链与越界路径、命令路径与兼容目录、inline 插件唯一目录、未知 category）；
  `packages/desktop/test/providerProvisioningLane.test.ts`（无 lane、running/最近结果按设备、失败阶段码 + 重试、执行中重试的尾随代际、waitForIdle）；
  `packages/desktop/src/host/windowHostAttachmentRpcPolicy.test.ts`（新增通道与五方法在手机上默认拒绝）。
- 全部使用临时 HOME / XDG / 临时目录，不读真实用户配置、不连远端、不启动真实 Host。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm fmt:check` 在整合时必须 0 新增。
