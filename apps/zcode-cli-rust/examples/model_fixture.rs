//! Test-only `HttpModel` driver for the M4 TS oracle. The shipped Agent still
//! only accepts app-server `--stdio`; this example exposes the public
//! `ModelPort` entrypoint on stdin/stdout so a Node test can send the same
//! fixture to the real TypeScript adapter and compare their semantics.
//!
//! Input (one JSON object per line): `{"config": <ModelConfig>, "messages": [...]}`.
//! Output (one JSON object per line): `{"ok": true, "text", "reason", "events"}`
//! or `{"ok": false, "reason", "statusCode"}`. It builds an empty `RuntimeEnv`
//! egress and never reads process environment or `HOME`.
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use zcode_cli_net::{Egress, NetworkPolicy, RuntimeEnv};
use zcode_cli_rust::adapters::{config::ModelConfig, provider::HttpModel};
use zcode_cli_rust::contract::{Event, EventSink, ModelPort, RequestOrigin};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 空环境 egress：不读取进程环境或 HOME，测试只连 loopback。
    let env = RuntimeEnv::from_vars(Vec::new());
    let egress = Arc::new(
        Egress::new(
            Arc::new(env),
            &NetworkPolicy::default(),
            Path::new("/nonexistent"),
            "test",
        )
        .expect("empty egress"),
    );
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let input: Value = serde_json::from_str(&line)?;
        let config: ModelConfig = serde_json::from_value(input["config"].clone())?;
        let messages = input["messages"].as_array().cloned().unwrap_or_default();
        let result = run(HttpModel::new(config, egress.clone()), messages).await;
        out.write_all(format!("{result}\n").as_bytes()).await?;
        out.flush().await?;
    }
    Ok(())
}

async fn run(model: HttpModel, messages: Vec<Value>) -> Value {
    let (tx, mut rx) = tokio::sync::mpsc::channel(128);
    let sink = EventSink {
        session_id: "m4-oracle".into(),
        run_id: "m4-oracle".into(),
        tx,
        origin: Arc::new(RequestOrigin::default()),
        request_auth: None,
    };
    let collector = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(run) = rx.recv().await {
            // 只暴露两侧共同的语义事件；状态/工具等宿主事件不参与 parity。
            if let Event::Text {
                text, reasoning, ..
            } = run.event
            {
                events.push(json!({"reasoning": reasoning, "text": text}));
            }
        }
        events
    });
    let result = model
        .complete(messages, &[], &sink, &CancellationToken::new())
        .await;
    drop(sink);
    let events = collector.await.unwrap_or_default();
    match result {
        Ok(output) => json!({
            "ok": true,
            "text": output.message["content"],
            "reason": output.raw_finish_reason,
            "events": events,
        }),
        Err(failure) => json!({
            "ok": false,
            "reason": failure.reason,
            "statusCode": failure.status_code,
        }),
    }
}
