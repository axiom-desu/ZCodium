//! 真实 office MCP 响应 → Rust 绑定/V4 投影（夹具由 documents 插件 `dist/server.mjs`
//! 的 tools/list 与 open_document 调用逐字节抓取，不是手写 mock）。
use super::{display, ui_descriptor, visibility};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../tests/data/office-mcp-responses.json"))
        .expect("valid captured office MCP responses")
}

fn tool<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["tools"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == name)
        .expect("captured tool")
}

#[test]
fn app_only_office_tools_are_not_model_visible() {
    let fixture = fixture();
    let names: Vec<&str> = fixture["tools"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .filter(|tool| visibility(tool).iter().any(|item| item == "model"))
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    // 模型工具表只保留 open/read/search/show/get_view；面板、导入与令牌入口全部排除。
    assert_eq!(
        names,
        vec![
            "open_document",
            "read_document",
            "search_document",
            "show_in_viewer",
            "get_view"
        ]
    );
    for name in [
        "list_documents",
        "load_document",
        "check_document",
        "get_viewer",
        "report_view",
        "release_view",
        "begin_file_import",
        "write_file_import",
        "finish_file_import",
        "cancel_file_import",
    ] {
        assert_eq!(
            visibility(tool(&fixture, name)),
            vec!["app"],
            "{name} is app-only"
        );
    }
}

#[test]
fn office_ui_metadata_reaches_the_binding() {
    let fixture = fixture();
    let ui = ui_descriptor(tool(&fixture, "open_document")).expect("ui descriptor");
    assert_eq!(ui["resourceUri"], "ui://documents/panel.html");
    assert_eq!(ui["surface"], "documents");
    assert_eq!(ui["preferredDisplayMode"], "fullscreen");
    // 纯数据工具没有 resourceUri，不生成 UI 展示，但不影响其可见性。
    assert!(ui_descriptor(tool(&fixture, "read_document")).is_none());
}

#[test]
fn real_mcp_result_projects_to_the_v4_host_display() {
    let fixture = fixture();
    let ui = ui_descriptor(tool(&fixture, "open_document")).expect("ui descriptor");
    let display = display("plugin:documents:documents", &ui, &fixture["open"]);
    assert_eq!(display["kind"], "mcp_tool");
    assert_eq!(display["pluginId"], "documents");
    assert_eq!(display["resourceUri"], "ui://documents/panel.html");
    assert_eq!(display["surface"], "documents");
    assert_eq!(display["preferredDisplayMode"], "fullscreen");
    let structured: Value = serde_json::from_str(
        display["structuredContent"]
            .as_str()
            .expect("structuredContent JSON text"),
    )
    .expect("structured content parses");
    assert_eq!(structured["document"]["path"], "docs/report.docx");
    assert_eq!(structured["reveal"]["targets"][0]["at"], "p:4");
    // 结果文本供页面内联展示；没有 isError/truncated 时不占字段。
    assert!(
        display["content"]
            .as_str()
            .unwrap()
            .contains("Opened docs/report.docx")
    );
    assert!(display.get("isError").is_none());
    assert!(display.get("truncated").is_none());
}

#[test]
fn oversized_result_fields_are_omitted_whole_and_counted() {
    let ui = json!({"resourceUri":"ui://pdf/panel.html","surface":"pdf"});
    let big = "x".repeat(70 * 1024);
    let result = json!({
        "content":[{"type":"text","text":big}],
        "structuredContent":{"text":big},
        "_meta":{"note":big},
        "isError":true,
    });
    let display = display("plugin:pdf:pdf", &ui, &result);
    assert!(display.get("structuredContent").is_none());
    assert!(display.get("widgetMeta").is_none());
    assert!(display.get("content").is_none());
    assert_eq!(display["truncated"], true);
    assert!(display["truncatedBytes"].as_u64().unwrap() > 70 * 1024);
    assert_eq!(display["isError"], true);
}
