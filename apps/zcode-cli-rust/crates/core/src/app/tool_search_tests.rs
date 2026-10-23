//! Core ToolSearch 接线的单元测试（spec `.agents/specs/upstream-3.16-sync-s6.md`）。
use super::context::RunContext;
use crate::contract::{EventSink, ModelOutput, ModelPort, ModelRequestOptions, ToolPort};
use crate::domain::context::ContextState;
use crate::domain::tool_search::{
    DEFERRED_TOOL_CALL_NAME, Mode, ResolvedMode, TOOL_SEARCH_NAME, WRAPPER_KEY,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Tools;

#[async_trait]
impl ToolPort for Tools {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> anyhow::Result<String> {
        Ok(String::new())
    }
    fn tool_search_metadata(&self, _: &str, name: &str) -> crate::domain::tool_search::Metadata {
        let mut metadata = crate::domain::tool_search::builtin_metadata(name);
        // 控制入口永不 deferred（与 tools crate 注册一致）。
        if matches!(name, TOOL_SEARCH_NAME | DEFERRED_TOOL_CALL_NAME) {
            metadata.should_defer = false;
        }
        metadata
    }
}

struct Model;

#[async_trait]
impl ModelPort for Model {
    async fn complete(
        &self,
        _: Vec<Value>,
        _: &[Value],
        _: &EventSink,
        _: &CancellationToken,
    ) -> std::result::Result<ModelOutput, crate::contract::ModelFailure> {
        Err(crate::contract::ModelFailure::invalid())
    }
    fn format_properties(&self) -> Value {
        json!({"inputFormat": {"supportsText": true}, "supportsToolCall": true})
    }
}

fn tool(name: &str) -> Value {
    json!({"type":"function","function":{"name":name,"description":"d","parameters":{"type":"object"}}})
}

fn definitions() -> Vec<Value> {
    vec![
        tool("Read"),
        tool(TOOL_SEARCH_NAME),
        tool(DEFERRED_TOOL_CALL_NAME),
        tool("TodoWrite"),
    ]
}

fn history(mode: Mode) -> RunContext {
    let mut history = RunContext::new(ContextState::default(), vec![], None, 0);
    history.tool_search_mode = mode;
    history
}

#[test]
fn local_plan_exposes_controls_and_projects_history() {
    let history = history(Mode::Local);
    let plan = super::tool_search::plan(&Model, &Tools, "s", &history, &definitions()).unwrap();
    let names: Vec<&str> = plan
        .tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        names,
        vec!["Read", TOOL_SEARCH_NAME, DEFERRED_TOOL_CALL_NAME]
    );
    assert!(!plan.options.tool_search_enabled);
    assert_eq!(plan.mode, ResolvedMode::Local);
    assert!(plan.search.is_some());
    // 历史引用在最终请求投影里展开为目标 schema。
    let messages = vec![
        json!({"role":"assistant","content":"","tool_calls":[
            {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[
            {"type":"tool_reference","toolName":"TodoWrite"}]}),
    ];
    let projected = plan.project(&messages);
    let content = projected[1]["content"].as_array().unwrap();
    assert!(
        content[0]["text"]
            .as_str()
            .is_some_and(|text| text.starts_with("<functions>\n<function>"))
    );
}

#[test]
fn off_plan_hides_controls_and_removes_references() {
    let history = history(Mode::Off);
    let plan = super::tool_search::plan(&Model, &Tools, "s", &history, &definitions()).unwrap();
    let names: Vec<&str> = plan
        .tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(names, vec!["Read", "TodoWrite"]);
    assert!(plan.search.is_none());
    let messages = vec![
        json!({"role":"assistant","content":"","tool_calls":[
            {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[
            {"type":"tool_reference","toolName":"TodoWrite"}]}),
    ];
    let projected = plan.project(&messages);
    assert_eq!(
        projected[1]["content"][0]["text"],
        "[Tool references removed - tool search not enabled]"
    );
}

#[test]
fn deferred_admission_rewrites_only_valid_deferred_targets() {
    let history = history(Mode::Local);
    let plan = super::tool_search::plan(&Model, &Tools, "s", &history, &definitions()).unwrap();
    let mut calls = vec![
        json!({"id":"c1","type":"function","function":{"name":DEFERRED_TOOL_CALL_NAME,
            "arguments":"{\"name\":\"TodoWrite\",\"input\":{\"todos\":[]}}"}}),
        // 常驻目标：保持包装身份，由执行返回普通错误且零执行。
        json!({"id":"c2","type":"function","function":{"name":DEFERRED_TOOL_CALL_NAME,
            "arguments":"{\"name\":\"Read\",\"input\":{}}"}}),
    ];
    super::tool_search::admit(&mut calls, plan.search.as_ref());
    assert_eq!(calls[0]["function"]["name"], "TodoWrite");
    assert_eq!(calls[0][WRAPPER_KEY], DEFERRED_TOOL_CALL_NAME);
    assert_eq!(calls[1]["function"]["name"], DEFERRED_TOOL_CALL_NAME);
    // 内部调用（live 行/事件/持久化）使用目标身份；包装名只在模型出口还原。
    assert_eq!(calls[0]["function"]["name"], "TodoWrite");
    // 有效包装调用的搜索执行返回真实引用。
    let search = plan.search.as_ref().unwrap();
    let output = search
        .execute(&json!({"query": "select:TodoWrite"}))
        .unwrap();
    assert_eq!(
        search
            .unwrap_call(&json!({"name":"TodoWrite","input":{"todos":[]}}))
            .unwrap()
            .0,
        "TodoWrite"
    );
    assert_eq!(
        output.model_content,
        Some(json!([{"type":"tool_reference","toolName":"TodoWrite"}]))
    );
    assert!(search.execute(&json!({"query": 1})).is_err());
}

struct NoToolCalls;

#[async_trait]
impl ModelPort for NoToolCalls {
    async fn complete(
        &self,
        _: Vec<Value>,
        _: &[Value],
        _: &EventSink,
        _: &CancellationToken,
    ) -> std::result::Result<ModelOutput, crate::contract::ModelFailure> {
        Err(crate::contract::ModelFailure::invalid())
    }
    fn format_properties(&self) -> Value {
        json!({"inputFormat": {"supportsText": true}, "supportsToolCall": false})
    }
}

#[test]
fn local_mode_reads_the_real_supports_tool_call_property() {
    // 注册配置缺字段时保持内置默认；显式 false 必须在发送前拒绝 Local。
    assert!(Model.supports_tool_call());
    let history = history(Mode::Local);
    assert!(super::tool_search::plan(&NoToolCalls, &Tools, "s", &history, &definitions()).is_err());
}

fn many_definitions() -> Vec<Value> {
    let mut definitions = definitions();
    for name in ["WebFetch", "TodoRead", "CronUpdate"] {
        definitions.push(json!({"type":"function","function":{
            "name": name, "description": "shared keyword", "parameters": {"type":"object"}}}));
    }
    definitions
}

#[test]
fn search_input_matches_zod_and_js_slice_semantics() {
    let history = history(Mode::Local);
    let plan =
        super::tool_search::plan(&Model, &Tools, "s", &history, &many_definitions()).unwrap();
    let search = plan.search.as_ref().unwrap();
    let names = |output: crate::contract::ToolOutput| {
        output.data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    // 缺省 max_results=5；未知键按非 strict zod 剥掉后继续执行。
    assert_eq!(
        names(
            search
                .execute(&json!({"query":"shared","unknown":true}))
                .unwrap()
        ),
        vec!["WebFetch", "TodoRead", "CronUpdate"]
    );
    // z.number() 接受小数，JS slice 向零截断。
    assert_eq!(
        names(
            search
                .execute(&json!({"query":"shared","max_results":2.5}))
                .unwrap()
        ),
        vec!["WebFetch", "TodoRead"]
    );
    // 负数按 Array#slice(0,-1) 去掉最后一条。
    assert_eq!(
        names(
            search
                .execute(&json!({"query":"shared","max_results":-1}))
                .unwrap()
        ),
        vec!["WebFetch", "TodoRead"]
    );
    // null 不是数字（zod invalid_type），与省略不同。
    assert!(
        search
            .execute(&json!({"query":"shared","max_results":null}))
            .is_err()
    );
    assert!(
        search
            .execute(&json!({"query":"shared","max_results":"3"}))
            .is_err()
    );
    assert!(search.execute(&json!({"max_results":1})).is_err());
    // UTF-8 选择名不得触发字节切片 panic。
    let output = search.execute(&json!({"query":"select:ẞ😀"})).unwrap();
    assert_eq!(output.data["matches"], json!([]));
    assert!(output.model_content.is_none());
}

#[test]
fn compact_checkpoint_keeps_real_references_only() {
    let mut history = history(Mode::Local);
    history.state.pre_compact_discovered_tools = vec!["WebFetch".into()];
    history.messages = vec![
        json!({"role":"assistant","content":"","tool_calls":[
            {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[
            {"type":"tool_reference","toolName":"TodoWrite"}]}),
        json!({"role":"assistant","content":"","tool_calls":[
            {"id":"c2","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c2","content":[
            {"type":"tool_reference","toolName":"Failed"}],"_zcode_tool_failed":true}),
    ];
    assert_eq!(
        super::tool_search::compact_discovery(&history),
        vec!["TodoWrite".to_owned(), "WebFetch".to_owned()]
    );
    // 模式偏好不影响既有 complete 调用方。
    assert!(!ModelRequestOptions::default().tool_search_enabled);
}
