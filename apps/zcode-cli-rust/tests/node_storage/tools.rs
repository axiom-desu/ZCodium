// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! An engine over a real `NodeStore` with a scripted model: every turn is a
//! `Read` tool step with reasoning, then the answer.
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use zcode_cli_rust::contract::*;

use super::model::IMAGE;

/// `Read`; the first execution waits for the gate when one is set.
pub(super) struct Tools {
    pub(super) gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    pub(super) root: PathBuf,
}
#[async_trait]
impl ToolPort for Tools {
    fn definitions(&self) -> Vec<Value> {
        vec![
            json!({"type": "function", "function": {"name": "Read", "parameters": {"type": "object"}}}),
            json!({"type": "function", "function": {"name": "Agent", "parameters": {"type": "object"}}}),
            json!({"type": "function", "function": {"name": "Write", "parameters": {"type": "object"}}}),
        ]
    }
    fn concurrent_safe(&self, _: &str) -> bool {
        true
    }
    async fn agent_output(&self, session: &str, _: &str) -> Result<String> {
        Ok(format!("agent-output/{session}.md"))
    }
    async fn execute_scoped(
        &self,
        name: &str,
        arguments: &Value,
        _: &EventSink,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput> {
        if name == "Write" {
            // Node Write 的结构化结果（workspace checkpoint 候选）。
            let path = self
                .root
                .join("w")
                .join(arguments["file_path"].as_str().unwrap_or(""));
            let content = arguments["content"].as_str().unwrap_or("");
            let data = json!({"type": "create", "filePath": path, "content": content,
                "originalFile": null, "structuredPatch": [{"oldStart": 1, "oldLines": 0,
                "newStart": 1, "newLines": 1, "lines": [format!("+{content}")]}]});
            return Ok(ToolOutput::new(
                format!("The file {} has been written successfully.", path.display()),
                data,
            ));
        }
        if arguments["file_path"] != "shot.png" {
            return Ok(ToolOutput::text(
                self.execute(name, arguments, cancel).await?,
            ));
        }
        let path = self.root.join("read-media.png");
        std::fs::write(&path, IMAGE)?;
        let asset = json!({"path": path, "mediaType": "image/png", "totalBytes": IMAGE.len()});
        let mut output = ToolOutput::new(
            "[Attached image/png: Read image]".into(),
            json!({"type": "image"}),
        );
        output.model_content = Some(json!([{"type": "_zcode_attachment", "asset": asset,
            "name": "shot.png", "placeholder": "Read image", "sizeBytes": IMAGE.len()}]));
        Ok(output)
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        let gate = self.gate.lock().unwrap().take();
        if let Some((started, release)) = gate {
            started.send(()).unwrap();
            release.await?;
        }
        Ok("1\tconst a = 1;".into())
    }
}
