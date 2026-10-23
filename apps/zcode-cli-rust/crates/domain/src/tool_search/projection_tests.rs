//! ToolSearch 引用投影的单元测试（spec S6）。
use super::*;

fn tool(name: &str) -> Value {
    json!({"type":"function","function":{"name":name,"description":"d","parameters":{"type":"object","properties":{}}}})
}

fn search_result(blocks: Value) -> Vec<Value> {
    vec![
        json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":blocks}),
    ]
}

#[test]
fn local_expands_definitions_and_adds_guidance() {
    let tools = vec![tool("TodoWrite"), tool("WebFetch")];
    let deferred: BTreeSet<String> = ["TodoWrite".to_owned(), "WebFetch".to_owned()].into();
    let messages = search_result(json!([
            {"type":"text","text":"found"},
            {"type":"tool_reference","toolName":"TodoWrite"},
            {"type":"text","text":"mid hook text"},
            {"type":"tool_reference","toolName":"WebFetch"}]));
    let projected = project_messages(&messages, ResolvedMode::Local, &tools, &deferred);
    let content = projected.messages[1]["content"].as_array().unwrap();
    assert_eq!(content[0]["text"], "found");
    // 连续引用合并为一个 functions 容器；中间文本截断容器。
    assert!(
        content[1]["text"]
            .as_str()
            .unwrap()
            .starts_with("<functions>\n<function>")
    );
    assert_eq!(content[2]["text"], "mid hook text");
    assert!(
        content[3]["text"]
            .as_str()
            .unwrap()
            .starts_with("<functions>")
    );
    let guidance = content[4]["text"].as_str().unwrap();
    assert!(guidance.contains("Loaded: TodoWrite, WebFetch. Call them now"));
    assert!(guidance.starts_with("<system-reminder>"));
    // Local 只在结果内提醒，不在批次外派生 Native 提示。
    assert_eq!(projected.messages.len(), 2);
    assert!(projected.loaded_call_ids.is_empty());
    // 原始历史未被修改。
    assert_eq!(messages[1]["content"].as_array().unwrap().len(), 4);
}

#[test]
fn local_dedupes_within_batch_and_reminds_already_loaded() {
    let tools = vec![tool("TodoWrite")];
    let deferred: BTreeSet<String> = ["TodoWrite".to_owned()].into();
    let messages = vec![
        json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[
                {"type":"tool_reference","toolName":"TodoWrite"}]}),
        // 下一轮 assistant 之后，同批结果才算已交付给模型。
        json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c2","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c2","content":[
                {"type":"tool_reference","toolName":"TodoWrite"}]}),
    ];
    let projected = project_messages(&messages, ResolvedMode::Local, &tools, &deferred);
    // 已交付后重复搜索结果只给已加载提醒，不重复 schema。
    let second = projected.messages[3]["content"].as_array().unwrap();
    assert!(!second.iter().any(|b| {
        b["text"]
            .as_str()
            .is_some_and(|t| t.contains("<functions>"))
    }));
    assert!(second.iter().any(|b| {
        b["text"]
            .as_str()
            .is_some_and(|t| t.contains("already available in this conversation"))
    }));
}

#[test]
fn local_dedupes_repeated_names_in_one_result() {
    let tools = vec![tool("TodoWrite")];
    let deferred: BTreeSet<String> = ["TodoWrite".to_owned()].into();
    let messages = search_result(json!([
            {"type":"tool_reference","toolName":"TodoWrite"},
            {"type":"tool_reference","toolName":"TodoWrite"}]));
    let projected = project_messages(&messages, ResolvedMode::Local, &tools, &deferred);
    let content = projected.messages[1]["content"].as_array().unwrap();
    let guidance = content
        .iter()
        .filter_map(|block| block["text"].as_str())
        .find(|text| text.contains("Loaded:"))
        .unwrap();
    // 提醒按名称去重：Loaded: TodoWrite. Call it now，而不是 TodoWrite, TodoWrite。
    assert!(guidance.contains("Loaded: TodoWrite. Call it now"));
    assert_eq!(guidance.matches("TodoWrite").count(), 1);
}

#[test]
fn off_hides_announcements_before_the_role_split() {
    let announcement = json!({
        "role":"user",
        "content":"<system-reminder>\nold announcement\n</system-reminder>",
        "_zcode_source":"tool_search_announcement",
        crate::tool_search::ANNOUNCEMENT_KEY: {"addedNames":["TodoWrite"],"removedNames":[],"readdedNames":[]}
    });
    let messages = vec![
        announcement.clone(),
        json!({"role":"assistant","content":"plain"}),
        json!({"role":"user","content":"next"}),
    ];
    let projected = project_messages(&messages, ResolvedMode::Off, &[], &BTreeSet::new());
    // Off 在按 role 分流之前隐藏公告：正文和 metadata 都不能进入请求。
    assert_eq!(projected.messages.len(), 2);
    assert!(
        !projected
            .messages
            .iter()
            .any(|m| m.get(crate::tool_search::ANNOUNCEMENT_KEY).is_some())
    );
    // Native/Local 保留公告（只由 Off 隐藏）。
    let kept = project_messages(&messages, ResolvedMode::Native, &[], &BTreeSet::new());
    assert_eq!(kept.messages.len(), 3);
}

#[test]
fn native_keeps_references_and_marks_loaded_outside_the_result_batch() {
    let tools = vec![tool("TodoWrite")];
    let messages = search_result(json!([{"type":"tool_reference","toolName":"TodoWrite"}]));
    let projected = project_messages(
        &messages,
        ResolvedMode::Native,
        &tools,
        &BTreeSet::from(["TodoWrite".to_owned()]),
    );
    assert_eq!(projected.loaded_call_ids.len(), 1);
    // 引用原样保留；成功提示在 tool_result 批次之外，不能写进结果内容。
    let content = projected.messages[1]["content"].as_array().unwrap();
    assert_eq!(
        content,
        &vec![json!({"type":"tool_reference","toolName":"TodoWrite"})]
    );
    assert_eq!(projected.messages[2]["role"], "user");
    assert_eq!(projected.messages[2]["content"], "Tool loaded.");
    assert_eq!(projected.messages.len(), 3);
}

#[test]
fn native_loaded_markers_follow_the_whole_contiguous_tool_batch() {
    let tools = vec![tool("TodoWrite"), tool("WebFetch")];
    let messages = vec![
        json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}},
                {"id":"c2","type":"function","function":{"name":"ToolSearch","arguments":"{}"}},
                {"id":"c3","type":"function","function":{"name":"Read","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[
                {"type":"tool_reference","toolName":"TodoWrite"}]}),
        json!({"role":"tool","tool_call_id":"c2","content":[
                {"type":"tool_reference","toolName":"Gone"}]}),
        json!({"role":"tool","tool_call_id":"c3","content":"1\tconst a = 1;"}),
    ];
    let projected = project_messages(
        &messages,
        ResolvedMode::Native,
        &tools,
        &BTreeSet::from(["TodoWrite".to_owned()]),
    );
    // 只有成功且仍有有效引用的 c1 产生提示；提示位于连续 tool 批次之后。
    assert_eq!(projected.loaded_call_ids.len(), 1);
    assert_eq!(projected.messages[1]["tool_call_id"], "c1");
    assert_eq!(projected.messages[2]["tool_call_id"], "c2");
    assert_eq!(projected.messages[3]["tool_call_id"], "c3");
    assert_eq!(projected.messages[4]["role"], "user");
    assert_eq!(projected.messages[4]["content"], "Tool loaded.");
    assert_eq!(projected.messages.len(), 5);
    // 失效引用使用占位，但不产生成功提示。
    assert_eq!(
        projected.messages[2]["content"][0]["text"],
        "[Tool references removed - tools no longer available]"
    );
}

#[test]
fn native_invalid_references_alone_do_not_mark_loaded() {
    let tools = vec![tool("TodoWrite")];
    let messages = search_result(json!([
            {"type":"text","text":"hook"},
            {"type":"tool_reference","toolName":"Gone"}]));
    let projected = project_messages(
        &messages,
        ResolvedMode::Native,
        &tools,
        &BTreeSet::from(["TodoWrite".to_owned()]),
    );
    assert!(projected.loaded_call_ids.is_empty());
    assert_eq!(projected.messages.len(), 2);
}

#[test]
fn off_and_missing_tools_use_placeholders() {
    let messages = search_result(json!([{"type":"tool_reference","toolName":"Gone"}]));
    let off = project_messages(&messages, ResolvedMode::Off, &[], &BTreeSet::new());
    assert_eq!(
        off.messages[1]["content"][0]["text"],
        "[Tool references removed - tool search not enabled]"
    );
    let native = project_messages(&messages, ResolvedMode::Native, &[], &BTreeSet::new());
    assert_eq!(
        native.messages[1]["content"][0]["text"],
        "[Tool references removed - tools no longer available]"
    );
}

#[test]
fn wrapped_calls_are_restored_at_model_exit() {
    let messages = vec![json!({"role":"assistant","content":"","tool_calls":[
            {"id":"c9","type":"function","function":{"name":"TodoWrite","arguments":"{\"todos\":[]}"},
             WRAPPER_KEY:"DeferredToolCall"}]})];
    let projected = project_messages(&messages, ResolvedMode::Local, &[], &BTreeSet::new());
    let call = &projected.messages[0]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "DeferredToolCall");
    let args: Value =
        serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(args, json!({"name":"TodoWrite","input":{"todos":[]}}));
}
