# Host 项目服务

唯一写者是当前 Host 的 tasks-index 存储。服务负责真实目录校验、默认目录创建；自动归档由本模块定时扫描器执行（启动首轮、每 5 分钟、设置变更补扫），不挂在任何读取或 UI 动作上；Repository 在事务内维护项目、roots 与任务归属。UI 只经 hooks 调用此契约。远程调用使用拥有组织态的现有 Host attachment，不让 main/relay 创建业务副本。

目录解析的 task 归属与 roots 来自同一读快照。已知 task 无项目时返回空附加目录；引用悬空项目或读取失败直接拒绝。prepareSession 的 cwd 创建后固定；编辑 roots 只影响下一次 runtime materialization。删除项目不删除会话；移动不写 CLI 事实、时间或 cwd。CLI continuous/replayable 流不由本模块修改。

全局创建显式空归属，不按目录猜项目。跨 host 移动失败；同 host 缺目录时先返回错误，用户明确确认后原子追加 root 与移动。可删除容器永久保留，恢复仅由新建时明确选择同 roots 的已删项目。

`prepareSession` 返回值冻结为创建/恢复目录合同：`workspacePath` 是 cwd，`additionalDirectories` 是本次会话明确允许的额外根（排序去重由 runtime 负责），`projectId` 是 Host 组织态 id。S8-C 的 TS/Rust runtime 直接消费该结果，不另建配置通道；热会话不因迟到项目编辑改 cwd。

`readProjects` 只查询项目/roots，不加载任务或触发 Agent；`readTree` 同样只读，两者都不触发自动归档。主目录可用性由 Host `stat` 派生为可选 `primaryRootStatus`，不写库不缓存；prepareSession 再次检查，失效直接拒绝。

旧远端缺少 `virtualProjects` 握手能力时只使用 adapters/legacy-single-root 的单 root 读适配器：读取远端旧 app 数据，不写本机项目、不启动 Agent，组织操作显式 `project.legacy-read-only`。合成 ID 由 host/cwd 稳定导出，升级时只允许入口版本 CAS 解析，不形成持久权威项目。
