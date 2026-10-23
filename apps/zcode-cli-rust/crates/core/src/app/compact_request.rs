//! compact 请求的候选目录与配套暴露；只借用，不拥有历史或端口。
use super::compaction::Request;
use crate::contract::ToolPort;
use serde_json::Value;

/// compact 的候选目录与配套暴露；`request` 只借用它们，避免调用方重复拼装。
pub(super) struct Prepared {
    pub tools: Vec<Value>,
    pub plan: super::tool_search::Plan,
}

impl Prepared {
    pub(super) fn request<'a>(
        &'a self,
        prefix: &'a [Value],
        tools: &'a [Value],
        reminder: Option<Value>,
        port: &'a dyn ToolPort,
    ) -> Request<'a> {
        Request {
            prefix,
            tools,
            summary_tools: &self.tools,
            tool_search: Some(&self.plan),
            options: &self.plan.options,
            reminder,
            port,
        }
    }
}
