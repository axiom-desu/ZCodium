//! ToolSearch 搜索/选择的差分单元测试（spec S6）。
use super::*;
use crate::tool_search::Metadata;

fn candidate(name: &str, description: &str, mcp: Option<(&str, &str)>) -> Candidate {
    let metadata = Metadata {
        should_defer: true,
        mcp: mcp.map(|(server_name, tool_name)| crate::tool_search::McpName {
            server_name: server_name.into(),
            tool_name: tool_name.into(),
        }),
        ..Default::default()
    };
    crate::tool_search::candidate(
        &serde_json::json!({"type":"function","function":{"name":name,"description":description,"parameters":{}}}),
        &metadata,
    )
}

#[test]
fn select_resolves_names_aliases_and_mcp_short_names() {
    let mut alias = candidate("WebFetch", "fetch a URL", None);
    alias.aliases = vec!["fetch".into()];
    let catalog = vec![
        alias,
        candidate("mcp__docs__lookup", "docs lookup", Some(("docs", "lookup"))),
        candidate("Read", "read", None),
    ];
    assert_eq!(
        search_tools("select:fetch, Read ,lookup", &catalog, 5),
        vec!["WebFetch", "Read", "mcp__docs__lookup"]
    );
    // 直接选择不截断 max_results。
    assert_eq!(
        search_tools("select:Read,WebFetch,lookup", &catalog, 1).len(),
        3
    );
    assert!(search_tools("select:missing", &catalog, 5).is_empty());
}

#[test]
fn keywords_rank_name_hint_and_description() {
    let catalog = vec![
        candidate("WebFetch", "fetch and extract content from a URL", None),
        candidate("TaskOutput", "read output", None),
        candidate("TodoWrite", "manage the checklist", None),
        crate::tool_search::candidate(
            &serde_json::json!({"type":"function","function":{"name":"Read","description":"read a file","parameters":{}}}),
            &Metadata::default(),
        ),
    ];
    assert_eq!(search_tools("fetch", &catalog, 5), vec!["WebFetch"]);
    assert_eq!(search_tools("checklist", &catalog, 5), vec!["TodoWrite"]);
    // 精确名称优先。
    assert_eq!(search_tools("TaskOutput", &catalog, 5), vec!["TaskOutput"]);
    // 关键词只搜索 deferred：常驻工具的 description 不参与关键词结果。
    assert!(search_tools("file", &catalog, 5).is_empty());
    // 精确名称可直接命中常驻工具。
    assert_eq!(search_tools("Read", &catalog, 5), vec!["Read"]);
    // 但 description 命中 deferred 时仍可返回。
    assert_eq!(search_tools("output", &catalog, 5), vec!["TaskOutput"]);
    // 正则特殊字符按字面匹配，不 panic。
    assert!(search_tools("a.b(", &catalog, 5).is_empty());
}

#[test]
fn required_terms_intersect_and_mcp_prefix_prefixes() {
    let catalog = vec![
        candidate(
            "mcp__slack__send_message",
            "send a message",
            Some(("slack", "send_message")),
        ),
        candidate("mcp__docs__send", "send docs", Some(("docs", "send"))),
        candidate("WebFetch", "fetch", None),
    ];
    assert_eq!(
        search_tools("+slack send", &catalog, 5),
        vec!["mcp__slack__send_message"]
    );
    assert_eq!(
        search_tools("mcp__docs", &catalog, 5),
        vec!["mcp__docs__send"]
    );
    assert!(search_tools("+missing send", &catalog, 5).is_empty());
}

#[test]
fn ties_keep_catalog_order_and_results_truncate() {
    let catalog = vec![
        candidate("Alpha", "shared", None),
        candidate("Beta", "shared", None),
        candidate("Gamma", "shared", None),
    ];
    assert_eq!(search_tools("shared", &catalog, 2), vec!["Alpha", "Beta"]);
    // JS Array#slice(0, end)：负数从末尾倒数，0 返回空。
    assert_eq!(search_tools("shared", &catalog, -1), vec!["Alpha", "Beta"]);
    assert!(search_tools("shared", &catalog, 0).is_empty());
    assert_eq!(model_visible_mcp_part("a b/c"), "a_b_c");
    assert_eq!(model_visible_mcp_part("!!"), "_");
}

#[test]
fn select_is_byte_safe_and_does_not_span_newlines() {
    let catalog = vec![
        candidate("Alpha", "first", None),
        candidate("Beta", "beta description", None),
    ];
    // 字节下标不再用大小写转换前后的长度差反推：不得 panic。
    assert!(search_tools("select:ẞ😀", &catalog, 5).is_empty());
    // `/^select:(.+)$/` 的 `.` 不跨行：退化到关键词搜索。
    assert_eq!(
        search_tools("select:Alpha\nbeta", &catalog, 5),
        vec!["Beta"]
    );
    // 空 rest 不满足 `.+`，同样走关键词。
    assert!(search_tools("select:", &catalog, 5).is_empty());
    // 大小写不敏感前缀。
    assert_eq!(search_tools("SELECT:Alpha", &catalog, 5), vec!["Alpha"]);
}

#[test]
fn keyword_boundaries_follow_js_ascii_word_semantics() {
    let catalog = vec![
        candidate("Alpha", "日本語 desc", None),
        candidate("Other", "日本語 desc", None),
        candidate("WebFetch", "prefetching is not fetch", None),
    ];
    // JS `\b` 只认 ASCII `\w`：中文两侧都不构成边界，不得假命中。
    assert!(search_tools("日本語", &catalog, 5).is_empty());
    // ASCII 边界仍然生效；单词内部的子串不算 `\bterm\b`。
    assert_eq!(search_tools("fetch", &catalog, 5), vec!["WebFetch"]);
    assert!(search_tools("prefetch", &catalog, 5).is_empty());
}
