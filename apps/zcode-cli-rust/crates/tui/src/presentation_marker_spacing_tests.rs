//! timelineMarker 行空白与未知 marker 的展示对齐测试。

use crate::{presentation::render_rows, projection::View};
use serde_json::json;

fn line_text(line: &ratatui::text::Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

#[test]
fn marker_rows_emit_exactly_one_blank_line_and_unknown_markers_none() {
    // 旧实现 marker 分支自己补一个空行、循环末尾再补一个，正文里出现双空行。
    let view = View {
        rows: vec![
            json!({"kind":"timelineMarker",
                "marker":{"type":"compact","origin":"manual","status":"success"}}),
            // 未知 marker 不造事实，也不占一行（不留空 row）。
            json!({"kind":"timelineMarker","marker":{"type":"mystery"}}),
            json!({"kind":"assistantText","text":"after"}),
        ],
        ..View::default()
    };
    let rows = render_rows(&view);
    let texts = rows.iter().map(line_text).collect::<Vec<String>>();
    assert_eq!(
        texts,
        vec![
            "── Context compressed (manual) ──".to_owned(),
            String::new(),
            "Assistant".to_owned(),
            "after".to_owned(),
            String::new(),
        ],
        "{texts:?}"
    );
    // 任何位置都不出现连续两个空行。
    assert!(
        !texts
            .windows(2)
            .any(|pair| pair[0].is_empty() && pair[1].is_empty()),
        "{texts:?}"
    );
}
