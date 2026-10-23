# 第三方许可材料补齐

## 目的与规则

用户要求补齐 PR #74 发布检查发现的许可材料，而不是关闭门禁。不得更改项目依赖版本、自动批准未知授权、使用其他版本许可冒充对应版本，或改写原始许可文本。

- Rust TUI 的锁定 Cargo crate 是唯一版本事实；归档没有原文时，优先依据已校验归档内 `.cargo_vcs_info.json` / Cargo.toml 的 repository 和 revision 定位同一源码 revision 的 LICENSE/COPYING/NOTICE。允许严格受限的备用证据：固定 release tag 必须解析到完整 commit，并通过归档与该 tag 源码的 Cargo.toml 版本及多项实际 crate 源文件逐字匹配，注册时将 tag、resolved revision、归档摘要和匹配路径/摘要绑定；不得只凭相同版本号/仓库名放宽原 verifier。normalized manifest 不作为匹配源文件。同步工具和校验器支持该登记，不覆盖 archive 来源，不生成推测版权。若上游仅有许可证选择声明，且声明明确允许选择特定标准许可证，可记录该选择并附标准许可证全文，但必须清晰标注其为标准条款文本、非上游原始文件，保留原声明来源/哈希与选择理由，不得伪称上游包含完整许可证或捏造作者。
- Rust TUI dev-dependency 变更也会改变 Cargo.lock 的锁哈希；需用现有生成器重验许可闭包并同步 sources/snapshots 与根第三方声明，不手改摘要跳过来源验证。
- registry metadata 只保留版本/许可/来源/发布档完整性等必要公开字段和原始响应摘要，不提交 publisher 联系信息或 npm 内部运维字段；原始许可和 NOTICE 则按原文保留。
- CUA 0.28.2、UBJS 0.31.0-3 按 npm publisher gitHead / 固定 tag 对应 commit 核对来源，保留 MIT 与 MPL-2.0 全文、上游 NOTICE，以及如何获取相应源码和本地打包变换的说明。MPL 复核仅针对已证实的精确 package/version/license expression，不加入泛化包名前缀豁免；缺材料、版本漂移、表达式变化仍阻断。
- 平台未安装的 override 只要仍在当前 pnpm 锁文件中就不是陈旧登记；生成器不得把 libc/平台过滤掉的有效许可材料当成已移除依赖。真正不在锁图的旧 override 仍需报错，不扩大运行时依赖或声明虚假已安装包。
- 许可原文与版本对应证据是事实 owner，生成的 THIRD-PARTY-NOTICES.md 和 inventory 是派生物；补齐后重新生成，不手工删除 reviewRequired。已确认仍无法核实的旧材料继续明确标记，不冒充 strict 全通过。
- 验收：原文快照 hash、锁定版本/来源对应（包含 tag-revision/source-match evidence registration 绑定及错误 tag/revision/source 内容负例）、额外上游材料遗漏/篡改或版本漂移的负例、标准条款清晰标记校验、许可生成、普通与 strict 检查；根 typecheck/lint/架构/格式和相关测试。CI 与打包路径保留，最终记录实际结果并更新同一 PR，不自动合并或发布。
