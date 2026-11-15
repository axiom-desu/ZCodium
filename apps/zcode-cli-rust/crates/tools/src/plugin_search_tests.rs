//! 搜索排序/游标的独立回归（与 `plugin_discovery` 的输入规则分离，更贴近 TS 的分词事实）。
use super::*;
use serde_json::json;
use zcode_cli_domain::plugin_discovery::SearchInput;

fn entry(id: &str, name: &str, description: &str) -> Value {
    json!({
        "pluginId": id,
        "name": name,
        "description": description,
        "installed": false,
        "enabled": false,
        "action": "install",
        "scope": "workspace"
    })
}

fn query(query: &str) -> SearchInput {
    SearchInput {
        query: query.into(),
        cursor: None,
    }
}

#[test]
fn tokens_split_han_bigrams_and_word_runs() {
    assert_eq!(tokens("PDF 文档 edit"), vec!["pdf", "文档", "edit"]);
    // 单汉字只有完整名称命中：query 里只有一个字时不产生 bigram 词项。
    assert_eq!(tokens("文"), Vec::<String>::new());
    assert_eq!(tokens("a1-b2"), vec!["a1", "b2"]);
}

#[test]
fn only_matching_entries_are_returned_with_plugins_identity() {
    let catalog = vec![
        entry("pdf@official", "pdf", "documents"),
        entry("slides@official", "slides", "presentations"),
    ];
    let output = search(&catalog, &query("presentations"), false).unwrap();
    let plugins = output["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0]["pluginId"], "slides@official");
}

#[test]
fn identical_ties_break_by_plugin_id() {
    let catalog = vec![
        entry("b@official", "same", "shared text"),
        entry("a@official", "same", "shared text"),
    ];
    let output = search(&catalog, &query("shared"), false).unwrap();
    let ids: Vec<&str> = output["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|plugin| plugin["pluginId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a@official", "b@official"]);
}

#[test]
fn revision_ignores_catalog_order_but_tracks_content() {
    let catalog = vec![
        entry("a@official", "alpha", "one"),
        entry("b@official", "beta", "two"),
    ];
    let reversed: Vec<Value> = catalog.iter().rev().cloned().collect();
    assert_eq!(revision("alpha", &catalog), revision("alpha", &reversed));
    let mut changed = catalog.clone();
    changed[0]["description"] = json!("one changed");
    assert_ne!(revision("alpha", &catalog), revision("alpha", &changed));
    // query 也是修订的一部分：换 query 必须换游标。
    assert_ne!(revision("alpha", &catalog), revision("beta", &catalog));
}
