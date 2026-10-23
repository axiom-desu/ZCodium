//! Session kind policy (Node `isReadonlyAgentSessionKind` /
//! `isAuxiliarySessionKind` in `packages/shared/src/zcode-protocol-legacy-types.ts`).
//!
//! 修复根因：原先各输入入口只判断 `subagent_child`，于是 workflow_child /
//! nested_workflow_child 能从旧标签页或 legacy `session/send` 继续输入，
//! 父链归属规则也漏掉了工作流子会话。值域与 TS 保持同一实现。

/// 由 Agent / 工作流驱动、对用户只读的子会话。
pub const READONLY_AGENT_SESSION_KINDS: [&str; 3] =
    ["subagent_child", "workflow_child", "nested_workflow_child"];

/// 只读子会话：不再接受用户输入。
pub fn is_readonly_agent_session_kind(kind: &str) -> bool {
    READONLY_AGENT_SESSION_KINDS.contains(&kind)
}

/// 辅助会话 = 只读三种 + `selection_side_chat`（可继续输入，但归属可沿父链证明）。
/// `fork` / `workflow_parent` 是独立任务，即使带 parentID 也不沿父链改写项目。
pub fn is_auxiliary_session_kind(kind: &str) -> bool {
    is_readonly_agent_session_kind(kind) || kind == "selection_side_chat"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_kinds_are_the_three_agent_driven_kinds() {
        for kind in ["subagent_child", "workflow_child", "nested_workflow_child"] {
            assert!(is_readonly_agent_session_kind(kind), "{kind}");
            assert!(is_auxiliary_session_kind(kind), "{kind}");
        }
        // 辅助对话仍可输入，但不是只读。
        assert!(!is_readonly_agent_session_kind("selection_side_chat"));
        assert!(is_auxiliary_session_kind("selection_side_chat"));
        for kind in ["interactive", "fork", "workflow_parent", ""] {
            assert!(!is_readonly_agent_session_kind(kind), "{kind}");
            assert!(!is_auxiliary_session_kind(kind), "{kind}");
        }
    }
}
