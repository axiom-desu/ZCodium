//! 工具 part 的 turn 内状态迁移（批次开始/结果落库）。
//! 拆分自 `turn.rs`，方法体逐字搬移，只为把源文件保持在 400 行上限内。
use super::super::records::{self as r};
use super::super::{Op, Step};
use crate::session::Session;
use serde_json::Value;

impl Session {
    fn step_tool(&mut self, call: &str) -> Option<(Step, usize)> {
        let step = self.node.turn.as_ref()?.step.clone()?;
        let index = step.tools.iter().position(|t| t.call == call)?;
        Some((step, index))
    }

    /// Node `onBatchStart`: the tool part turns `running`.
    pub fn node_tool_started(&mut self, now: u64, call: &str) {
        let Some((mut step, index)) = self.step_tool(call) else {
            return;
        };
        let tool = &mut step.tools[index];
        tool.started = Some(now);
        let state = r::running_tool(&tool.name, &tool.input, now);
        let part = r::tool_part(
            &tool.part,
            &self.id,
            &step.assistant,
            (&tool.call, tool.index, &tool.name),
            super::super::tool_metadata(tool),
            state,
        );
        self.node.push(now, Op::Part(part));
        self.node.turn.as_mut().unwrap().step = Some(step);
    }

    /// Node tool result persistence; the step completes after its last tool.
    /// `media`: the result's stored media (Node `persistToolResultMediaAttachments`).
    pub fn node_tool_done(
        &mut self,
        now: u64,
        call: &str,
        (content, display, failed): (&Value, Option<&Value>, bool),
        model_content: Option<&Value>,
        media: Option<&super::super::tool_media::ToolMedia>,
        ids: &mut dyn FnMut() -> String,
    ) {
        let Some((mut step, index)) = self.step_tool(call) else {
            return;
        };
        let tool = &mut step.tools[index];
        let window = (tool.started.unwrap_or(now), now);
        let state = if failed {
            r::error_tool(&tool.input, content, model_content, window)
        } else {
            let mut state = r::completed_tool(
                &tool.name,
                &tool.input,
                content,
                display,
                model_content,
                window,
            );
            if let Some(media) = media {
                state["metadata"]["modelContentLayout"] = Value::Array(media.layout.clone());
                let parts = media.files.iter().map(|file| {
                    file.part(
                        &super::super::part_id(now, &ids()),
                        &self.id,
                        &step.assistant,
                    )
                });
                state["attachments"] = Value::Array(parts.collect());
            }
            state
        };
        tool.done = true;
        let part = r::tool_part(
            &tool.part,
            &self.id,
            &step.assistant,
            (&tool.call, tool.index, &tool.name),
            super::super::tool_metadata(tool),
            state,
        );
        self.node.push(now, Op::Part(part));
        let finished = step.tools.iter().all(|t| t.done);
        self.node.turn.as_mut().unwrap().step = Some(step);
        if finished {
            self.complete_step(now, super::super::part_id(now, &ids()), None);
        }
    }
}
