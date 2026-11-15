use crate::usage::{SectionChars, js_len};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSnapshot {
    pub cwd: String,
    pub platform: String,
    pub shell: String,
    pub os_version: String,
    pub current_date: String,
    pub git: Option<GitSnapshot>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub main_branch: String,
    pub user: String,
    pub status: String,
    pub recent_commits: String,
}
/// 读取到的指令文件（`ContextPort` 的投影）。3.18 起由公告渲染，不再嵌入请求前缀。
pub struct InstructionSource {
    pub path: String,
    pub user: bool,
    pub content: String,
    pub truncated: bool,
    /// 显式公告类型（auto-memory 用）；缺省按 `user` 推 project/user。
    pub kind: Option<String>,
}

/// 一次指令来源读取：成功读到的文件，以及**存在但读不出来**的路径。
/// 读不出来的路径不算删除（安全修复 F1）：模型保留已宣告的副本。
#[derive(Default)]
pub struct InstructionRead {
    pub sources: Vec<InstructionSource>,
    pub unreadable: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Templates {
    user_steer: String,
    cli: String,
    identity: String,
    desktop: String,
    behavior: String,
    context_management: String,
}
fn templates() -> &'static Templates {
    static TEMPLATES: OnceLock<Templates> = OnceLock::new();
    TEMPLATES.get_or_init(|| {
        serde_json::from_str(include_str!("prompt_templates.json"))
            .expect("validated prompt assets")
    })
}
pub fn user_steer(text: &str) -> String {
    templates()
        .user_steer
        .replacen("{zcode_input_text}", text, 1)
}
pub fn prefix(snapshot: &PromptSnapshot, model: Option<(&str, &str)>, desktop: bool) -> Vec<Value> {
    prefix_with_chars(snapshot, model, desktop, &[]).0
}
/// The request prefix and the characters of its system and meta-user context
/// sections (Node `ContextSection.chars`, spec rust-m9-usage-logs §4.2).
/// 指令文件不在请求前缀里：3.18 起由 `instruction_files` 公告（含 preamble）作为
/// provider 可见的 model-only notice 落库，见 `.agents/specs/upstream-3.18-rust-context.md`。
pub fn prefix_with_chars(
    snapshot: &PromptSnapshot,
    model: Option<(&str, &str)>,
    desktop: bool,
    additional_directories: &[String],
) -> (Vec<Value>, SectionChars) {
    let templates = templates();
    let mut chars = SectionChars {
        system: [
            &templates.cli,
            &templates.identity,
            &templates.behavior,
            &templates.context_management,
        ]
        .map(|t| js_len(t))
        .iter()
        .sum(),
        ..SectionChars::default()
    };
    if desktop {
        chars.system += js_len(&templates.desktop);
    }
    let stable = if desktop {
        format!("{}\n\n{}", templates.identity, templates.desktop)
    } else {
        templates.identity.clone()
    };
    let additional = if additional_directories.is_empty() {
        String::new()
    } else {
        format!(
            "\n- Additional directories:{}",
            additional_directories
                .iter()
                .map(|path| format!("\n  - {path}"))
                .collect::<String>()
        )
    };
    let mut env = format!(
        "# Environment\nYou have been invoked in the following environment:\n- Primary working directory: {}{}\n- Is a git repository: {}\n- Platform: {}\n- Shell: {}\n- OS Version: {}",
        snapshot.cwd,
        additional,
        if snapshot.git.is_some() { "yes" } else { "no" },
        snapshot.platform,
        snapshot.shell,
        snapshot.os_version,
    );
    if let Some((provider, model)) = model {
        env.push_str(&format!(
            "\n- You are powered by the model named {provider}/{model}."
        ));
    }
    chars.system += js_len(&env);
    let mut dynamic = format!(
        "\n\n{}\n\n{env}\n\n{}",
        templates.behavior, templates.context_management
    );
    if let Some(git) = &snapshot.git {
        let start = dynamic.len() + 2;
        dynamic.push_str("\n\ngitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.");
        for (label, value) in [
            ("Current branch", &git.branch),
            (
                "Main branch (you will usually use this for PRs)",
                &git.main_branch,
            ),
            ("Git user", &git.user),
        ] {
            if !value.is_empty() {
                dynamic.push_str(&format!("\n\n{label}: {value}"));
            }
        }
        dynamic.push_str(&format!(
            "\n\nStatus:\n{}\n\nRecent commits:\n{}",
            if git.status.is_empty() {
                "(clean)"
            } else {
                &git.status
            },
            git.recent_commits
        ));
        chars.system += js_len(&dynamic[start..]);
    }
    // system 末尾的固定余额行（官方 `TOTAL_TOKENS_SYSTEM_LINE`）。
    dynamic.push_str("\n\n");
    dynamic.push_str(&crate::total_tokens::system_line());
    chars.system += crate::usage::js_len(&crate::total_tokens::system_line());
    let mut messages = [&templates.cli, &stable, &dynamic].map(|content| {
        json!({"role":"system","content":content,"_zcode_cache_control":{"type":"ephemeral"}})
    }).to_vec();
    let mut context = vec![];
    if !snapshot.current_date.is_empty() {
        context.push(format!(
            "# currentDate\nToday's date is {}.",
            snapshot.current_date
        ));
    }
    chars.meta_user = context.iter().map(|c| js_len(c)).sum();
    if !context.is_empty() {
        let body = format!(
            "As you answer the user's questions, you can use the following context:\n{}\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
            context.join("\n\n")
        );
        static NESTED: OnceLock<regex::Regex> = OnceLock::new();
        let escaped = NESTED
            .get_or_init(|| regex::Regex::new(r"(?i)</?system-reminder\b").unwrap())
            .replace_all(&body, |caps: &regex::Captures<'_>| {
                format!("&lt;{}", &caps[0][1..])
            });
        messages.push(json!({"role":"user","content":format!("<system-reminder>\n{escaped}\n</system-reminder>\n")}));
    }
    (messages, chars)
}

#[cfg(test)]
mod additional_directory_tests {
    use super::*;

    #[test]
    fn model_environment_lists_the_frozen_additional_directories() {
        let snapshot = PromptSnapshot {
            cwd: "/w".into(),
            platform: "linux".into(),
            shell: "bash".into(),
            os_version: "linux".into(),
            ..Default::default()
        };
        let (prefix, _) =
            prefix_with_chars(&snapshot, None, false, &["/shared".into(), "/other".into()]);
        let rendered = serde_json::to_string(&prefix).unwrap();
        assert!(rendered.contains("Additional directories"));
        assert!(rendered.contains("/shared"));
        assert!(rendered.contains("/other"));
        let (empty, _) = prefix_with_chars(&snapshot, None, false, &[]);
        assert!(
            !serde_json::to_string(&empty)
                .unwrap()
                .contains("Additional directories")
        );
    }
}
