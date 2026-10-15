//! Grep 的行切分与模型文案，对齐 TS adapter/`formatGrepModelContent`。
//! 从 `tool_search` 拆出以保持单文件在架构行数上限内。
use serde_json::Value;

/// 对齐 TS `splitRipgrepSearchLines`：空内容无行，只去掉一个末尾换行，CRLF 作为分隔符，
/// 而单独 CR 归入行内容；含非法 UTF-8 的行返回 raw 字节供调用方判定。
pub(crate) fn grep_raw_lines(data: &[u8]) -> Vec<&[u8]> {
    if data.is_empty() {
        return vec![];
    }
    let body = data
        .strip_suffix(b"\r\n")
        .or_else(|| data.strip_suffix(b"\n"))
        .unwrap_or(data);
    let parts: Vec<&[u8]> = body.split(|byte| *byte == b'\n').collect();
    let last = parts.len().saturating_sub(1);
    parts
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            // 只有被 \n 终止的行才去掉 CR；末尾单独的 CR 属于内容。
            if index == last {
                line
            } else {
                line.strip_suffix(b"\r").unwrap_or(line)
            }
        })
        .collect()
}

/// 对齐 TS `formatGrepModelContent`：文案只由结构化输出字段推导，避免第二套事实。
pub(crate) fn grep_model(output: &Value) -> String {
    let mode = output
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("files_with_matches");
    let limit_info = grep_limit_info(output);
    let content = output
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("No matches found");
    match mode {
        "content" => {
            if limit_info.is_empty() {
                content.to_owned()
            } else {
                format!("{content}\n\n[Showing results with pagination = {limit_info}]")
            }
        }
        "count" => {
            let matches = output
                .get("numMatches")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let files = output.get("numFiles").and_then(Value::as_u64).unwrap_or(0);
            let summary = format!(
                "Found {matches} total {} across {files} {}.",
                plural(matches, "occurrence"),
                plural(files, "file")
            );
            if limit_info.is_empty() {
                format!("{content}\n\n{summary}")
            } else {
                format!("{content}\n\n{summary} with pagination = {limit_info}")
            }
        }
        _ => {
            let filenames = output
                .get("filenames")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let file_count = output
                .get("numFiles")
                .and_then(Value::as_u64)
                .unwrap_or(filenames.len() as u64);
            if file_count == 0 {
                return "No files found".to_owned();
            }
            let list = filenames
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            let suffix = if limit_info.is_empty() {
                String::new()
            } else {
                format!(" {limit_info}")
            };
            format!(
                "Found {file_count} {}{suffix}\n{list}",
                plural(file_count, "file")
            )
        }
    }
}

/// 对齐 TS `formatLimitInfo`：默认 250/0 不落到输出，只有真实截断或正 offset 才提示。
fn grep_limit_info(output: &Value) -> String {
    let mut parts = vec![];
    if let Some(limit) = output.get("appliedLimit").and_then(Value::as_u64) {
        parts.push(format!("limit: {limit}"));
    }
    if let Some(offset) = output.get("appliedOffset").and_then(Value::as_u64) {
        parts.push(format!("offset: {offset}"));
    }
    parts.join(", ")
}

fn plural(count: u64, noun: &str) -> String {
    if count == 1 {
        noun.to_owned()
    } else {
        format!("{noun}s")
    }
}

#[cfg(test)]
mod tests {
    use super::{grep_model, grep_raw_lines};
    use serde_json::json;

    #[test]
    fn raw_lines_follow_ripgrep_line_splitting() {
        assert!(grep_raw_lines(b"").is_empty());
        // 只去掉一个末尾换行；CRLF 作为分隔符，末尾单独的 CR 属于内容。
        assert_eq!(grep_raw_lines(b"a\nb\n"), vec![&b"a"[..], &b"b"[..]]);
        assert_eq!(grep_raw_lines(b"a\r\nb\r\n"), vec![&b"a"[..], &b"b"[..]]);
        assert_eq!(
            grep_raw_lines(b"a\rb\ngamma\r"),
            vec![&b"a\rb"[..], &b"gamma\r"[..]]
        );
        // 含非法 UTF-8 的行保留原始字节，供调用方判定后输出空文本。
        let invalid = [b'b', 0xff, b'\n'];
        assert_eq!(grep_raw_lines(&invalid), vec![&[b'b', 0xff][..]]);
    }

    #[test]
    fn model_text_derives_from_structured_fields() {
        // content 无分页时直接用 content；只有真实截断/正 offset 才追加分页后缀。
        assert_eq!(
            grep_model(&json!({"mode": "content", "content": "a:1:x"})),
            "a:1:x"
        );
        assert_eq!(
            grep_model(&json!({
                "mode": "content",
                "content": "a:1:x",
                "appliedLimit": 2,
                "appliedOffset": 1
            })),
            "a:1:x\n\n[Showing results with pagination = limit: 2, offset: 1]"
        );
        // count 汇总按结构化 numMatches/numFiles 推导，并处理单复数。
        assert_eq!(
            grep_model(&json!({
                "mode": "count",
                "content": "a:2",
                "numMatches": 2,
                "numFiles": 1
            })),
            "a:2\n\nFound 2 total occurrences across 1 file."
        );
        assert_eq!(
            grep_model(&json!({"mode": "files_with_matches", "numFiles": 0})),
            "No files found"
        );
        assert_eq!(
            grep_model(&json!({
                "mode": "files_with_matches",
                "numFiles": 1,
                "filenames": ["a.txt"]
            })),
            "Found 1 file\na.txt"
        );
    }
}
