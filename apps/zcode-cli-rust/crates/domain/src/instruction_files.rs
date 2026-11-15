//! 上游 3.18.2 F1：指令文件公告（`.agents/specs/upstream-3.18-rust-context.md`）。
//!
//! 语义来源：官方 `core/src/context/sections/instruction-files.ts` 与
//! `core/src/runtime/methods/context-refresh.ts`；形状参照 MBearo/ZCode-rs
//! `crates/context/src/instructions.rs`（Apache-2.0，仅语义，不复制结构）。
//! 这里只做纯判定：公告正文、增量与「已公告」合并；读取与落库由 core/engine 负责。
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// 公告的提醒来源（官方 `context_prefix`）。
pub const SOURCE: &str = "context_prefix";
/// canonical 消息上的公告事实键；冷恢复按同键重建，热历史与冷历史必须一致。
pub const KEY: &str = "_zcode_instructions";

pub const PREAMBLE: &str = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

pub const TYPE_PROJECT: &str = "project instructions, checked into the codebase";
pub const TYPE_USER: &str = "user's private global instructions for all projects";
/// 项目记忆索引（`MEMORY.md`，跨会话持久）。
pub const TYPE_AUTO_MEMORY: &str = "user's auto-memory, persists across conversations";

/// 上游 `isMainMemoryTaskType`：只有这些任务读取项目记忆索引。
pub fn reads_auto_memory(task_type: &str) -> bool {
    matches!(
        task_type,
        "" | "interactive" | "fork" | "selection_side_chat" | "workflow_parent"
    )
}

/// 重读原因：只有会话开始与压缩后两种。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SessionStart,
    Compaction,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::Compaction => "compaction",
        }
    }

    fn phrase(self) -> &'static str {
        match self {
            Self::SessionStart => "when this session started",
            Self::Compaction => "after the conversation was compacted",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "session_start" => Some(Self::SessionStart),
            "compaction" => Some(Self::Compaction),
            _ => None,
        }
    }
}

/// 公告里的一条文件记录（只带 hash，不带正文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub hash: String,
}

/// 当前读到的指令文件；正文已去首尾空白，hash 只算一次。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File {
    pub path: String,
    pub kind: String,
    pub body: String,
    pub hash: String,
}

impl File {
    pub fn new(path: impl Into<String>, kind: impl Into<String>, body: &str) -> Self {
        let body = body.trim().to_owned();
        let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        Self {
            path: path.into(),
            kind: kind.into(),
            body,
            hash,
        }
    }

    pub fn record(&self) -> Record {
        Record {
            path: self.path.clone(),
            kind: self.kind.clone(),
            hash: self.hash.clone(),
        }
    }
}

/// 一条公告：`files` 只含本次新增或变化的文件；`removed` 与 `reason` 仅在增量里有。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Announcement {
    pub files: Vec<Record>,
    pub removed: Vec<String>,
    pub reason: Option<Reason>,
}

impl Announcement {
    pub fn is_full(&self) -> bool {
        self.reason.is_none()
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("files".into(), Value::Array(records(&self.files)));
        if !self.removed.is_empty() {
            out.insert("removed".into(), self.removed.clone().into());
        }
        if let Some(reason) = self.reason {
            out.insert("reason".into(), reason.name().into());
        }
        Value::Object(out)
    }

    /// 严格解析：形状不对按「没有公告事实」处理，不做宽松修复。
    pub fn from_value(value: &Value) -> Option<Self> {
        let files = value.get("files")?.as_array()?;
        let mut parsed = vec![];
        for file in files {
            let path = file.get("path")?.as_str()?;
            let kind = file.get("type")?.as_str()?;
            let hash = file.get("hash")?.as_str()?;
            parsed.push(Record {
                path: path.into(),
                kind: kind.into(),
                hash: hash.into(),
            });
        }
        let removed = match value.get("removed").filter(|v| !v.is_null()) {
            Some(removed) => removed
                .as_array()?
                .iter()
                .map(|path| path.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
            None => vec![],
        };
        let reason = match value.get("reason").filter(|v| !v.is_null()) {
            Some(reason) => Some(Reason::parse(reason.as_str()?)?),
            None => None,
        };
        Some(Self {
            files: parsed,
            removed,
            reason,
        })
    }
}

fn records(files: &[Record]) -> Vec<Value> {
    files
        .iter()
        .map(|file| {
            let mut out = Map::new();
            out.insert("path".into(), file.path.clone().into());
            out.insert("type".into(), file.kind.clone().into());
            out.insert("hash".into(), file.hash.clone().into());
            Value::Object(out)
        })
        .collect()
}

/// 一个文件块：`Contents of <path> (<type>):`、空行、正文。
pub fn block(file: &File) -> String {
    format!(
        "Contents of {} ({}):\n\n{}",
        file.path, file.kind, file.body
    )
}

/// 完整公告：preamble 加全部文件块。
pub fn render_full(files: &[File]) -> String {
    let blocks: Vec<String> = files.iter().map(block).collect();
    format!("{PREAMBLE}\n\n{}", blocks.join("\n\n"))
}

/// 增量公告：变化/新增的文件共用一句说明，再跟删除。
pub fn render_delta(changed: &[File], removed: &[String], reason: Reason) -> String {
    let reread = format!(
        "Instruction files were re-read {}",
        match reason {
            Reason::SessionStart => Reason::SessionStart.phrase(),
            Reason::Compaction => Reason::Compaction.phrase(),
        }
    );
    let head = if changed.is_empty() {
        format!("{reread}.")
    } else {
        let blocks: Vec<String> = changed.iter().map(block).collect();
        format!(
            "{reread}; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:\n\n{}",
            blocks.join("\n\n")
        )
    };
    let mut parts = vec![head];
    parts.extend(
        removed
            .iter()
            .map(|path| format!("Instructions no longer present: {path}")),
    );
    parts.join("\n\n")
}

/// 历史里已公告的文件：最后一条完整公告作基准，再按顺序套用其后的增量。
/// 覆盖不改位置、删除即移除；没有完整公告时 `None`（下一次请求发完整公告）。
pub fn announced(messages: &[Value]) -> Option<Vec<Record>> {
    let parsed: Vec<Announcement> = messages
        .iter()
        .filter_map(|message| message.get(KEY))
        .filter_map(Announcement::from_value)
        .collect();
    let base = parsed.iter().rposition(Announcement::is_full)?;
    let mut known: Vec<Record> = vec![];
    for announcement in &parsed[base..] {
        for file in &announcement.files {
            match known.iter_mut().find(|record| record.path == file.path) {
                Some(record) => *record = file.clone(),
                None => known.push(file.clone()),
            }
        }
        known.retain(|record| !announcement.removed.contains(&record.path));
    }
    Some(known)
}

/// 相对已公告状态的增量；没有变化返回 `None`。
/// `unreadable` 里的路径视为读取失败：不算删除，模型保留已宣告的副本。
pub fn delta(
    current: &[File],
    known: &[Record],
    reason: Reason,
    unreadable: &[String],
) -> Option<Announcement> {
    let changed: Vec<File> = current
        .iter()
        .filter(|file| {
            !known.iter().any(|record| {
                record.path == file.path && record.hash == file.hash && record.kind == file.kind
            })
        })
        .cloned()
        .collect();
    let removed: Vec<String> = known
        .iter()
        .filter(|record| {
            !unreadable.contains(&record.path)
                && !current.iter().any(|file| file.path == record.path)
        })
        .map(|record| record.path.clone())
        .collect();
    if changed.is_empty() && removed.is_empty() {
        return None;
    }
    Some(Announcement {
        files: changed.iter().map(File::record).collect(),
        removed,
        reason: Some(reason),
    })
}

/// 一条公告的 canonical 提醒消息（与冷恢复重建的形状一致）。
pub fn message(body: &str, announcement: &Announcement) -> Value {
    let mut out = Map::new();
    out.insert("role".into(), "user".into());
    out.insert(
        "content".into(),
        crate::node_history::reminders::wrap(SOURCE, body).into(),
    );
    out.insert("_zcode_source".into(), SOURCE.into());
    out.insert(KEY.into(), announcement.to_value());
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(path: &str, body: &str, user: bool) -> File {
        File::new(path, if user { TYPE_USER } else { TYPE_PROJECT }, body)
    }

    #[test]
    fn full_announcement_carries_preamble_and_trimmed_blocks() {
        let files = vec![
            file("/w/AGENTS.md", "  one  \n", false),
            file("/h/AGENTS.md", "two", true),
        ];
        let text = render_full(&files);
        assert!(text.starts_with(PREAMBLE));
        assert!(text.contains(&format!(
            "Contents of /w/AGENTS.md ({TYPE_PROJECT}):\n\none"
        )));
        assert!(text.ends_with(&format!("Contents of /h/AGENTS.md ({TYPE_USER}):\n\ntwo")));
    }

    #[test]
    fn announced_merges_deltas_after_the_last_full_announcement() {
        let first = Announcement {
            files: vec![
                file("/a", "a", false).record(),
                file("/b", "b", false).record(),
            ],
            ..Default::default()
        };
        let delta = Announcement {
            files: vec![file("/a", "a2", false).record()],
            removed: vec!["/b".into()],
            reason: Some(Reason::Compaction),
        };
        let messages = vec![
            json!({"role": "assistant", "content": "x"}),
            message("full", &first),
            message("delta", &delta),
        ];
        let known = announced(&messages).unwrap();
        assert_eq!(
            known,
            vec![Record {
                path: "/a".into(),
                kind: TYPE_PROJECT.into(),
                hash: file("/a", "a2", false).hash,
            }]
        );
    }

    #[test]
    fn no_full_announcement_means_resend() {
        let delta = Announcement {
            files: vec![file("/a", "a", false).record()],
            removed: vec![],
            reason: Some(Reason::SessionStart),
        };
        assert_eq!(announced(&[message("delta", &delta)]), None);
    }

    #[test]
    fn delta_reports_changed_and_removed_but_not_unreadable() {
        let known = vec![
            file("/a", "a", false).record(),
            file("/b", "b", false).record(),
        ];
        let current = vec![file("/a", "a2", false), file("/c", "c", true)];
        let first = delta(&current, &known, Reason::SessionStart, &["/b".into()]).unwrap();
        assert_eq!(first.files.len(), 2, "changed /a and new /c");
        assert!(first.removed.is_empty(), "unreadable /b is not a removal");
        assert_eq!(first.reason, Some(Reason::SessionStart));
        assert!(
            render_delta(&current[..1], &[], Reason::Compaction)
                .contains("were re-read after the conversation was compacted")
        );

        let removed = delta(&current, &known, Reason::Compaction, &[]).unwrap();
        assert_eq!(removed.removed, vec!["/b".to_string()]);
        let known_now: Vec<Record> = current.iter().map(File::record).collect();
        assert!(delta(&current, &known_now, Reason::Compaction, &[]).is_none());
    }

    #[test]
    fn parse_is_strict_about_shape() {
        assert_eq!(
            Announcement::from_value(&json!({"files": [{"path": "/a"}]})),
            None
        );
        assert_eq!(
            Announcement::from_value(
                &json!({"files": [{"path": "/a", "type": "t", "hash": "h"}], "reason": "rewind"})
            ),
            None
        );
        let full = json!({"files": [{"path": "/a", "type": "t", "hash": "h"}]});
        assert!(Announcement::from_value(&full).unwrap().is_full());
    }
}
