//! Rust TUI 已实现命令的静态目录。
//!
//! 帮助与补全都只从这张表派生：表外的 core slash 能力不能被虚报为终端可用。
//! 目录只描述“用户可输入什么”，业务执行仍由 `command_dispatch` 走原有端口。
use anyhow::{Result, anyhow};

/// 一条已实现的终端命令。字段按 spec 固定，补全与帮助共用。
pub(crate) struct Command {
    /// canonical 名称，不含前导 `/`。
    pub(crate) name: &'static str,
    pub(crate) aliases: &'static [&'static str],
    pub(crate) usage: &'static str,
    pub(crate) summary_en: &'static str,
    pub(crate) summary_zh: &'static str,
}

impl Command {
    fn summary(&self, zh: bool) -> &'static str {
        if zh { self.summary_zh } else { self.summary_en }
    }
    /// 帮助行：用法 + 摘要，别名单独一行，避免把别名当成独立命令广告。
    fn describe(&self, zh: bool) -> String {
        let mut text = format!("{} — {}", self.usage, self.summary(zh));
        if !self.aliases.is_empty() {
            let aliases = self
                .aliases
                .iter()
                .map(|alias| format!("/{alias}"))
                .collect::<Vec<_>>()
                .join(" ");
            text.push_str(&format!(
                "\n{}: {aliases}",
                if zh { "别名" } else { "aliases" }
            ));
        }
        text
    }
}

const COMMANDS: &[Command] = &[
    Command {
        name: "help",
        aliases: &[],
        usage: "/help [command]",
        summary_en: "List the commands this terminal implements, or describe one",
        summary_zh: "列出终端已实现的命令，或查看单个命令说明",
    },
    Command {
        name: "new",
        aliases: &[],
        usage: "/new",
        summary_en: "Start a fresh session in the current workspace",
        summary_zh: "在当前 workspace 新建会话",
    },
    Command {
        name: "sessions",
        aliases: &[],
        usage: "/sessions",
        summary_en: "Choose a resumable session from the workspace",
        summary_zh: "从当前 workspace 选择可恢复会话",
    },
    Command {
        name: "resume",
        aliases: &[],
        usage: "/resume <sessionId>",
        summary_en: "Resume a session by id",
        summary_zh: "按 id 恢复会话",
    },
    Command {
        name: "mode",
        aliases: &[],
        usage: "/mode <build|plan|edit|yolo>",
        summary_en: "Choose the execution mode through the session owner",
        summary_zh: "通过会话 owner 切换执行模式",
    },
    Command {
        name: "model",
        aliases: &[],
        usage: "/model [providerId modelId [reasoningLevel]]",
        summary_en: "Choose a model, or pass the exact selection",
        summary_zh: "选择模型，或直接给出精确选择",
    },
    Command {
        name: "compact",
        aliases: &["compress"],
        usage: "/compact [instructions]",
        summary_en: "Ask the runtime to compact this conversation",
        summary_zh: "请求运行时压缩当前会话上下文",
    },
    Command {
        name: "effort",
        aliases: &["variant"],
        usage: "/effort [list|<level>]",
        summary_en: "Show or set the reasoning level offered by the current model",
        summary_zh: "查看或设置当前模型提供的推理档位",
    },
    Command {
        name: "queue",
        aliases: &[],
        usage: "/queue [list|pause|resume|edit|delete|send|up|down <id>]",
        summary_en: "Inspect or change the actor-owned queued inputs",
        summary_zh: "查看或修改由 actor 持有的排队输入",
    },
    Command {
        name: "mcp",
        aliases: &[],
        usage: "/mcp",
        summary_en: "Refresh the real MCP server status shown in the sidebar",
        summary_zh: "刷新侧栏显示的真实 MCP 服务器状态",
    },
    Command {
        name: "usage",
        aliases: &[],
        usage: "/usage",
        summary_en: "Query this session's real token usage",
        summary_zh: "查询当前会话的真实 token 用量",
    },
    Command {
        name: "quit",
        aliases: &["exit"],
        usage: "/quit",
        summary_en: "Leave the terminal UI",
        summary_zh: "退出终端界面",
    },
];

/// 帮助与补全的唯一来源。
pub(crate) fn all() -> &'static [Command] {
    COMMANDS
}

/// 按 canonical 名称或别名查找；允许带或不带前导 `/`。
pub(crate) fn find(token: &str) -> Option<&'static Command> {
    let token = token.strip_prefix('/').unwrap_or(token);
    COMMANDS
        .iter()
        .find(|command| command.name == token || command.aliases.contains(&token))
}

/// `/help` 与 `/help <command>` 的正文；未知命令是本地错误，不发送给模型。
pub(crate) fn help(topic: Option<&str>, zh: bool) -> Result<String> {
    match topic {
        None => Ok(all()
            .iter()
            .map(|command| command.describe(zh))
            .collect::<Vec<_>>()
            .join("\n")),
        Some(topic) => find(topic)
            .map(|command| command.describe(zh))
            .ok_or_else(|| {
                anyhow!(
                    "{}",
                    if zh {
                        format!("未实现的命令：{topic}。使用 /help 查看已实现命令。")
                    } else {
                        format!("Unknown command: {topic}. Use /help to list implemented commands.")
                    }
                )
            }),
    }
}

/// `/compact`/`/compress` 的附加指令。
///
/// 只按“完整首 token”识别，因此 `/compactfoo` 不是控制命令；返回的剩余文本仅去掉
/// 首尾空白，内部空白与换行原样保留（压缩附注是有意义的正文）。
pub(crate) fn compact_instructions(text: &str) -> Option<&str> {
    let text = text.trim();
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    let (token, rest) = text.split_at(end);
    matches!(token, "/compact" | "/compress").then(|| rest.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_is_the_only_source_for_help_and_aliases() {
        assert!(find("/compact").is_some_and(|c| c.aliases == ["compress"]));
        assert!(find("variant").is_some_and(|c| c.name == "effort"));
        assert!(find("compactfoo").is_none());
        let listing = help(None, false).unwrap();
        assert!(listing.contains("/compact [instructions]"));
        assert!(listing.contains("/effort [list|<level>]"));
        assert!(listing.contains("/mcp"));
        assert!(listing.contains("/usage"));
        assert!(help(Some("/compress"), true).unwrap().contains("别名"));
        assert!(help(Some("mcp"), false).unwrap().contains("/mcp"));
    }

    #[test]
    fn compact_instructions_keep_inner_whitespace_and_reject_longer_tokens() {
        assert_eq!(compact_instructions("/compact"), Some(""));
        assert_eq!(compact_instructions("/compress   "), Some(""));
        assert_eq!(
            compact_instructions("  /compact  keep  these\n\nlines  "),
            Some("keep  these\n\nlines")
        );
        assert_eq!(compact_instructions("/compactfoo hi"), None);
        assert_eq!(compact_instructions("/compressed"), None);
        assert_eq!(compact_instructions("hello"), None);
    }
}
