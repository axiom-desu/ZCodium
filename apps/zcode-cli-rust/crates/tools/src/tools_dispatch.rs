//! Existing workspace dispatch, split from tools.rs for the source-line boundary.
use super::{WorkspaceTools, check_cancel, resolve, string};
use crate::contract::{EventSink, InputValidationError, ToolOutput};
use anyhow::{Result, bail};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

impl WorkspaceTools {
    pub(super) async fn call_inner(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        sink: Option<&EventSink>,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput> {
        // Bash 的取消由 shell 层分类为 Node `createStoppedResult` 的 cancelled 结果。
        if name != "Bash" {
            check_cancel(cancel)?;
        }
        if !args.is_object() {
            bail!(InputValidationError::new(
                "Tool arguments must be an object"
            ));
        }
        let artifacts = self.session_artifacts(session);
        match name {
            name if name.starts_with("mcp__") => self.mcp.call(session, name, args, cancel).await,
            "Read" | "Write" | "Edit" => {
                let state = self
                    .reads
                    .lock()
                    .await
                    .entry(session.to_owned())
                    .or_default()
                    .clone();
                let files = crate::tool_files::FileTools {
                    sink,
                    checkpoint_root: &self.artifacts,
                    cwd: &self.cwd,
                    artifacts: &artifacts,
                    env: &self.env,
                    state: &state,
                    writes: &self.writes,
                };
                files.call(name, args, cancel).await
            }
            "Glob" | "Grep" => crate::tool_search::search(&self.cwd, name, args, cancel).await,
            // Kept for existing native transcripts, but no longer advertised to the model.
            "List" => {
                let path = resolve(&self.cwd, string(args, "path")?)?;
                let mut dir = tokio::fs::read_dir(path).await?;
                let mut entries = vec![];
                while let Some(entry) = dir.next_entry().await? {
                    check_cancel(cancel)?;
                    entries.push(entry.file_name().to_string_lossy().into_owned());
                    if entries.len() >= 1000 {
                        break;
                    }
                }
                entries.sort();
                Ok(ToolOutput::text(entries.join("\n")))
            }
            "Bash" | "TaskOutput" | "TaskStop" => {
                self.shell
                    .call((&self.cwd, &artifacts), session, name, args, sink, cancel)
                    .await
            }
            // Node：未注册的工具以 `Tool not found: {name}` 失败。
            _ => bail!("Tool not found: {name}"),
        }
    }
}
