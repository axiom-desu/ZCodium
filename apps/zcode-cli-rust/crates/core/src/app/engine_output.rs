//! Actor outbox flush; split from engine.rs to keep the Rust source-line boundary.
use super::{Engine, engine::RuntimeOutput};
use anyhow::Result;

impl Engine {
    pub(super) async fn flush(&mut self, output: &RuntimeOutput) -> Result<()> {
        if !self.outbox.is_empty() {
            output.send(std::mem::take(&mut self.outbox)).await?;
        }
        Ok(())
    }
}
