//! Executor contract tests: no new validator, typed decode, original failure rendering.
use super::*;
use crate::contract::{ModelFailure, ModelOutput, ModelPort};
use crate::domain::tool_search::{Candidate, ResolvedMode};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Tools(AtomicUsize);
#[async_trait::async_trait]
impl ToolPort for Tools {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok("owner accepted".into())
    }
}
struct Model;
#[async_trait::async_trait]
impl ModelPort for Model {
    async fn complete(
        &self,
        _: Vec<Value>,
        _: &[Value],
        _: &EventSink,
        _: &CancellationToken,
    ) -> std::result::Result<ModelOutput, ModelFailure> {
        Err(ModelFailure::invalid())
    }
}
fn search() -> super::super::tool_search::SearchContext {
    super::super::tool_search::SearchContext {
        enabled: true,
        mode: ResolvedMode::Native,
        catalog: vec![Candidate {
            name: "FixtureDeferred".into(),
            deferred: true,
            ..Default::default()
        }],
        discovered: Default::default(),
        definitions: vec![json!({"function":{"name":"FixtureDeferred","parameters":{
            "type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}}})],
    }
}

#[tokio::test]
async fn decode_is_typed_but_executor_never_revalidates_the_tool_schema() {
    let tools = Tools(AtomicUsize::new(0));
    let search = search();
    let skills = Default::default();
    let filter = Default::default();
    let scope = Scope {
        search: Some(&search),
        skills: &skills,
        profile: None,
        profiles: &[],
        selection: None,
        permissions: None,
        tool_filter: &filter,
        hooks: None,
        model: &Model,
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let sink = EventSink {
        session_id: "s".into(),
        run_id: "r".into(),
        tx,
        origin: Default::default(),
        request_auth: None,
    };
    let call = |arguments: &str| json!({"id":"same-id","function":{"name":"FixtureDeferred","arguments":arguments}});
    let (id, output, failed) = execute(&tools, &scope, call("{"), &sink, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(id, "same-id");
    assert!(failed);
    assert_eq!(
        output.error,
        Some(("InputValidationError", "input_validation_failed"))
    );
    assert!(
        output
            .content
            .starts_with("Invalid tool JSON arguments\n\n")
    );
    assert!(output.content.contains("select:FixtureDeferred"));
    assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    assert!(matches!(
        rx.recv().await.unwrap().event,
        Event::ToolStart { .. }
    ));
    assert!(matches!(
        rx.recv().await.unwrap().event,
        Event::ToolExecuting { .. }
    ));

    let (_, output, failed) = execute(
        &tools,
        &scope,
        call(r#"{"value":"not an integer"}"#),
        &sink,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!failed, "the handler is the sole owner of its input rules");
    assert_eq!(output.content, "owner accepted");
    assert_eq!(tools.0.load(Ordering::SeqCst), 1);
}

#[test]
fn guidance_uses_only_diagnostic_and_current_deferred_discovery_facts() {
    let typed = InputValidationError::new("wrong input").into();
    let search = search();
    for error in [
        anyhow::anyhow!("InputValidationError wrong input"),
        crate::contract::ToolError::handler(1, "InputValidationError"),
    ] {
        let mut output = ToolOutput::text(crate::contract::render_failure(&error));
        let original = output.content.clone();
        super::super::tool_input_guidance::append(
            &mut output,
            Some(&error),
            Some(&search),
            "FixtureDeferred",
        );
        assert_eq!(output.content, original);
        assert_eq!(output.error, None);
    }
    for variant in ["disabled", "discovered", "resident", "missing"] {
        let mut search = search.clone();
        match variant {
            "disabled" => search.enabled = false,
            "discovered" => {
                search.discovered.insert("FixtureDeferred".into());
            }
            "resident" => search.catalog[0].deferred = false,
            "missing" => search.catalog.clear(),
            _ => unreachable!(),
        }
        let mut output = ToolOutput::text("wrong input".into());
        super::super::tool_input_guidance::append(
            &mut output,
            Some(&typed),
            Some(&search),
            "FixtureDeferred",
        );
        assert_eq!(output.content, "wrong input");
        assert_eq!(
            output.error,
            Some(("InputValidationError", "input_validation_failed"))
        );
    }
}

#[test]
fn tagging_a_rendered_validation_envelope_keeps_its_original_cause() {
    let original = "<tool_use_error>InputValidationError: original details</tool_use_error>";
    let error =
        InputValidationError::caused_by(crate::contract::ToolError::Rendered(original.into()));
    assert!(error.is::<InputValidationError>());
    assert!(error.is::<crate::contract::ToolError>());
    assert_eq!(crate::contract::render_failure(&error), original);
}
