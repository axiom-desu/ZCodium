# Browser Use 与子代理共用 tab（Browser Control for Subagents）

让子代理也能用 Browser Use，并把 tab 归属显式化。上游 3.15.1 移除了
`Browser is not available in subagent`，本仓库跟随（上游设计变更记录
`apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`，2026-10-09）。

**这不是新能力，是删掉一个把合法能力挡住的判断**：原来只按 `runtime_scope === "subagent"`
一刀切拒绝，既不看子会话是否合法，也不区分 tab 归属。放开之后判定改由「子会话是否经父
runtime 登记」承担——未登记的子会话仍然被拒。

## 产品规则

1. 子代理可以使用 Browser Use，其行为与主代理一致（同一套工具、schema 与权限）。
2. tab 归属只有两种，且必须显式声明：
   - **父会话**（core Agent 子代理）：子代理与当前对话共用 tab。用户能在面板里看到子代理
     开的 tab，子代理也能看到对话里已有的 tab。子代理结束**不关 tab**。
   - **子会话自己**（dwf actor）：tab 归子会话，运行结束即连 tab 一起关闭——子会话永远不会
     作为一段对话回来认领它们。
3. **Computer Use 的限制不变**：CUA 仍拒绝 subagent。它拦截在子代理策略层
   （`core/src/subagent/computer-use-policy.ts`）与宿主层（`node-repl-host/src/cua-bridge.ts`）
   两处，理由是它会抢用户桌面焦点，与沙箱内的浏览器不同构。

## 状态所有者

| 状态                  | 所有者                                               | 说明                                                   |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| 子会话 → 父会话的登记 | `browser-control-broker`（每个 server context 一份） | 只由 `forChildSession` 写入；登记结束即删除            |
| tab 归属              | 下发的 `sessionId`                                   | 桌面按它判定 tab 属于哪段对话、面板是否展开            |
| tab 的生命周期        | 桌面 `browserGuestManager`                           | 唯一执行者：`turnEnded` / `closeSession` / `closeTabs` |
| browser 连接记忆      | 同上 broker 共享状态                                 | 按**实际下发的属性**记；被拒的请求不留条目             |
| 子会话的 tab 归属标记 | broker 的 `parentTabOwnerChildren`                   | 决定下发时是否把 sessionId 换成父会话                  |

**一份状态、一个入口。** 此前 broker 状态存在各自实例的闭包里，而同一个 server context 里
broker 会被造两次——进程级 node_repl 用一份、每个 app 的 runtime 端口用另一份。于是子会话
在 app 实例上登记、请求却经进程级实例到达，登记根本不生效（上游 2026-09-30 的真机记录：
某次会话用了 Browser 却一条 `turnEnded` 都没有）。所以状态改为按 server context 共享
（`WeakMap`），两侧是同一份。

## 接口

```typescript
export type BrowserChildSessionTabOwner = "child" | "parent";

export interface BrowserControlPort {
  list(input): Promise<BrowserBackendDescriptor[]>;
  execute(input): Promise<BrowserCommandResult>;
  turnEnded?(input): Promise<void>;
  closeSession?(input): Promise<void>;

  /** 为一个客户端不认识的子会话派生端口；登记结束前有效。 */
  forChildSession?(input: {
    childSessionId: string;
    parentSessionId: string;
    tabOwner?: BrowserChildSessionTabOwner; // 默认 "child"
  }): BrowserControlPort;
}

// 命令面新增一个可选字段
| { method: "closeSession"; closeTabs?: boolean }
```

- `workspace` / `clientMode` 永远按 `parentSessionId` 的会话解析——子会话只有父会话的
  workspace 事实。
- 端口没有 `forChildSession`（CLI headless CDP 不按客户端会话校验 sessionId）时，子会话
  直接沿用父端口。
- 调用方：core Agent 子代理用 `tabOwner: "parent"`；dwf actor 用默认的 `"child"`；
  legacy workflow child **不传**——它没有关闭链路，给它端口等于留下永不回收的登记。

## 事件顺序

### core Agent 子代理（与当前对话共用 tab）

```text
父会话 ──forChildSession(child, parent, tabOwner: parent)──▶ broker 登记 child→parent
子代理 browsers.* ──▶ broker 把下发 sessionId 换成父会话 ──▶ 桌面把 tab 记在父会话名下
                                                              （面板展开，tabs.list 可见）
子代理轮次结束 ──turnEnded──▶ no-op（不向桌面发生命周期）
子代理运行结束 ──closeSession──▶ 只撤销登记；tab 保持原状
父会话结束   ──turnEnded / closeSession──▶ 真正释放 / 关闭 tab
```

「轮次结束」和「运行结束」都不能替父会话收尾——那会把用户正在看的 tab 释放掉，所以派生
端口对这两个调用是空操作，只有登记被清掉。

### dwf actor（tab 归子会话）

```text
actor ──forChildSession(child, parent)──▶ broker 登记（tabOwner 默认 child）
actor browsers.* ──▶ 下发 sessionId = 子会话自己
actor 结束 ──closeSession──▶ 下发 closeSession{ closeTabs: true } + 撤销登记
```

`closeTabs: true` 只给「永远不会回来认领」的子会话：`closeSession` 只释放 guest、保留
view，而这类子会话保留的 view 无人可见、无人可认领，只会一直挂着 guest。

### 拒绝路径（不放宽的部分）

```text
请求 ──▶ node-repl bridge / bootstrap broker（不再按 runtime_scope 拒绝）
      ──▶ BrowserControlPort.requireSession（权威校验）
            ├─ 会话存在                       → 放行
            ├─ 已登记的子会话                 → 按父会话解析后放行
            └─ 未登记 / 已登记结束            → 拒绝（与从未登记一样）
```

## 幂等与清理边界

- `forChildSession` 重复调用同一 `(childSessionId, parentSessionId)` 是幂等的：登记表是
  Map/Set 写入，重复登记不产生第二份。
- 登记结束用父会话一致性校验（`childSessionParents.get(child) === parent`）保护，避免一个
  后来登记的父会话被前一个的清理误删。
- 连接记忆只在**会话校验通过之后**写入：被拒的请求不在共享状态里留条目。
- 子会话的 `turnEnded` / `closeSession` 不向桌面发生命周期（tabOwner: parent），因此不存在
  「子代理把父会话的 tab 关掉」这条路径。

## 验收场景

1. **共用 tab**：子代理 `tabs.list()` 含父会话已有的 tab；子代理新开的 tab 在当前对话面板
   可见；子代理结束后这些 tab 仍打开；父会话可继续读写原 tab 状态。
2. **不误关**：`tabOwner: "parent"` 的子代理发 `turnEnded` / `closeSession` 时，桌面收到的
   browser 生命周期请求数为 0。
3. **dwf 收尾**：dwf actor 结束后，其名下 tab（含已释放回该 session 的 view）被真正关闭。
4. **未登记仍被拒**：不经 `forChildSession` 的子会话请求仍被 `requireSession` 拒绝，错误信息
   与放松前不同（不再是按 runtime_scope 的一刀切）。
5. **状态共享**：同一个 server context 下，经 runtime 端口登记的子会话，其进程级 node_repl
   请求也能解析到父会话（这是 2026-09-30 那条 bug 的回归守卫）。
6. **CUA 不回归**：`node-repl-host/test/cua-bridge.test.ts` 的
   `rejects subagents before opening the broker` 仍必须通过。
7. **版本一致**：`node-repl-host` 的 package.json、`.zcodium-plugin/plugin.json`、
   `tool-contract.ts` 的 `NODE_REPL_SERVER_VERSION`、官方 seed 定义、SEA 清单五处版本一致。

## 依赖方向

```text
contracts（端口与命令面）
  ├─ core            派生子端口（forChildSession）
  ├─ bootstrap       实现端口（browser-control-broker）、去掉 broker 侧拒绝
  └─ node-repl-host  去掉 bridge 侧拒绝（不再关心 runtime_scope）
desktop              执行 tab 生命周期（closeSession / closeTabs）
```

不新增所有者，不新增持久化：登记只活在 broker 进程内，随登记结束消失。
