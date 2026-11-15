//! 用户消息的冷读投影（envelope / synthetic / prompt attachment）。
//! 拆分自 `hydrate.rs`，函数体逐字搬移，只为把源文件保持在 400 行上限内。
use super::{
    ArtifactReader, Entry, Value, block_has_text, file_block, json, prompt_attachment,
    provider_text, synthetic_attachment, user_metadata,
};

pub(super) fn user_entries(parts: &[Value], artifacts: ArtifactReader) -> Vec<Entry> {
    let (mut attachments, mut prompt, mut media) = (vec![], vec![], vec![]);
    let (mut synthetic, mut reminders_) = (vec![], vec![]);
    for part in parts {
        match part["type"].as_str() {
            Some("text") if part["ignored"] != true => match synthetic_attachment(part) {
                Some(entry) => synthetic.push(entry),
                None => prompt.push(json!({"type": "text", "text": provider_text(part)})),
            },
            Some("file") => {
                let block = file_block(part, artifacts);
                if block["type"] == "text"
                    && let Some(body) = prompt_attachment(part, &block)
                {
                    reminders_.push(Entry::Attachment {
                        source: "prompt_attachment".into(),
                        content: body,
                        metadata: None,
                    });
                    continue;
                }
                if matches!(block["type"].as_str(), Some("image" | "video")) {
                    media.push(block);
                } else {
                    attachments.push(block);
                }
            }
            Some("agent") => prompt.push(json!({"type": "text",
                "text": format!("[Selected agent: {}]", part["name"].as_str().unwrap_or(""))})),
            _ => {}
        }
    }
    let preserve = !attachments.is_empty() || !media.is_empty();
    let blocks: Vec<Value> = attachments.into_iter().chain(prompt).chain(media).collect();
    let has_content = blocks.iter().any(block_has_text);
    let content = if preserve || blocks.iter().any(|b| b["type"] != "text") {
        Value::Array(blocks)
    } else {
        let texts: Vec<&str> = blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !t.is_empty())
            .collect();
        Value::String(texts.join("\n\n"))
    };
    let user = user_metadata(parts);
    let envelope = has_content || (user["source"] == "real_user" && !reminders_.is_empty());
    if !envelope && synthetic.is_empty() && reminders_.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    if envelope {
        out.push(Entry::Message {
            message: json!({"role": "user", "content": content}),
            metadata: Some(user),
            tokens: None,
        });
    }
    out.extend(synthetic);
    out.extend(reminders_);
    out
}
