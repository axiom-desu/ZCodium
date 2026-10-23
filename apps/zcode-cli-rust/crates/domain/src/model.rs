use serde::Serialize;
use std::fmt;

/// Node `Model.requestCapabilities.toolSearch`：实际非凭据能力事实。
/// `protocol_supported` 只看协议（Anthropic Messages），`default_enabled` 额外要求
/// 真实 coding-plan 访问方式；不恢复已移除的 requestAuth/highspeed/offpeak 分支。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSearchCapability {
    pub protocol_supported: bool,
    pub default_enabled: bool,
}

impl ToolSearchCapability {
    pub fn new(protocol_supported: bool, default_enabled: bool) -> Self {
        Self {
            protocol_supported,
            default_enabled,
        }
    }

    /// Anthropic Messages 加真实 coding-plan 访问方式（Node
    /// `resolveToolSearchCapability`：`zhipu-coding-plan-api-key` 或 `zhipu-account` 的
    /// individual/team coding plan）。`access_type`/`access_mode` 均为非秘密配置。
    pub fn for_access(anthropic: bool, access_type: &str, access_mode: Option<&str>) -> Self {
        let coding_plan = access_type == "zhipu-coding-plan-api-key"
            || (access_type == "zhipu-account"
                && matches!(
                    access_mode,
                    Some("individual-coding-plan" | "team-coding-plan")
                ));
        Self::new(anthropic, anthropic && coding_plan)
    }
}

/// 模型端口可选的新增请求选项；缺省（全部 false）与既有 `complete` 完全等价。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModelRequestOptions {
    /// 仅代表 Native ToolSearch 协议（不发 Local 展开或 off 全目录）。
    pub tool_search_enabled: bool,
}

impl ModelRequestOptions {
    pub fn native_tool_search() -> Self {
        Self {
            tool_search_enabled: true,
        }
    }
}

/// 分类字段可跨 adapter/app 边界；诊断文案仅使用受控常量，避免泄漏供应商响应。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFailure {
    pub code: &'static str,
    pub reason: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    pub status_code: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub output_committed: bool,
    #[serde(skip)]
    pub empty_completion: bool,
    /// Provider response facts for network status only (never logged or shown).
    #[serde(skip)]
    pub detail: Option<Box<FailureDetail>>,
    /// 失败响应里 provider 真实报告的 usage（Node `AiSdkModelAdapterError.usage`）。
    /// 只随终止失败事件结算一次；缺 usage 保持 None，不猜 0。
    /// 装箱只为不放大 `Result<_, ModelFailure>`（clippy `result_large_err`）。
    #[serde(skip)]
    pub usage: Option<Box<serde_json::Value>>,
}

/// What the failing provider response said (Node `inspectProviderFailure`).
#[derive(Clone, Debug, Default)]
pub struct FailureDetail {
    /// Sanitized response headers (`name → value`).
    pub response_headers: serde_json::Map<String, serde_json::Value>,
    pub provider_error_code: Option<String>,
    pub provider_error_message: Option<String>,
    pub provider_request_id: Option<String>,
}
/// The code and the controlled message of a failure `reason` (the message
/// Node's model adapter error carries).
pub fn describe(reason: &str) -> (&'static str, &'static str) {
    match reason {
        "cancelled" => ("model_request_cancelled", "Model request was cancelled."),
        "timeout" => ("model_request_timeout", "Model request timed out."),
        "stream_idle_timeout" => ("model_request_timeout", "Model stream stalled."),
        "rate_limited" => (
            "model_rate_limited",
            "Provider rate limited the model request.",
        ),
        "auth_failed" => ("provider_not_configured", "Provider authentication failed."),
        "context_exceeded" => ("model_context_exceeded", "Model context window exceeded."),
        "attachment_unavailable" => (
            "attachment_unavailable",
            "An attachment snapshot is missing or invalid.",
        ),
        // Node `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE`（UI 按该码本地化）。
        "media_budget" => (
            "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
            "Current attachments are too large to send. Remove or compress attachments and try again.",
        ),
        "attachment_unsupported" => (
            "attachment_unsupported",
            "The selected model does not support an attachment format.",
        ),
        "model_output_limit_exceeded" => (
            "model_output_limit_exceeded",
            "The model's response exceeded the output token maximum.",
        ),
        "invalid_request" => (
            "invalid_model_request",
            "Provider rejected the model request.",
        ),
        // Node tool-transform：只有 Anthropic 协议能编码 provider 原生搜索。
        "native_search_chat" => (
            "invalid_model_request",
            "Provider API kind openai-compatible does not encode provider-native WebSearch",
        ),
        "native_search_responses" => (
            "invalid_model_request",
            "Provider API kind openai does not encode provider-native WebSearch",
        ),
        "invalid_response" => (
            "invalid_model_response",
            "Provider response was invalid or incomplete.",
        ),
        // 未实现 ToolSearch 协议的端口拒绝 native 请求（Node 在发送前报 invalid_model_request）。
        "tool_search_unsupported" => (
            "invalid_model_request",
            "Selected model does not support native ToolSearch.",
        ),
        "tls_error" => ("model_request_failed", "Provider TLS validation failed."),
        "network_error" => (
            "model_request_failed",
            "Provider connection or stream interrupted.",
        ),
        "provider_overloaded" => ("model_request_failed", "Provider is overloaded."),
        "server_error" => ("model_request_failed", "Provider returned a server error."),
        _ => ("model_request_failed", "Model request failed."),
    }
}

impl ModelFailure {
    pub fn new(reason: &'static str, retryable: bool) -> Self {
        let (code, message) = describe(reason);
        Self {
            code,
            reason,
            message,
            retryable,
            status_code: None,
            retry_after_ms: None,
            output_committed: false,
            empty_completion: false,
            detail: None,
            usage: None,
        }
    }
    pub fn invalid() -> Self {
        Self::new("invalid_response", false)
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", false)
    }
    pub fn empty() -> Self {
        Self {
            empty_completion: true,
            // 修复：Node 的空响应文本让 UI 识别为 empty_model_response，旧文本会被归为无效响应。
            message: "Model returned no text, no tool calls, and no usage before completing the turn.",
            ..Self::new("invalid_response", true)
        }
    }
}
impl fmt::Display for ModelFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for ModelFailure {}

impl ModelFailure {
    /// The V4 `lastError` of a run that failed on this request.
    pub fn last_error(&self, (provider, model): (&str, &str), now: u64) -> serde_json::Value {
        // Node 把终止的空完成归因为 empty_model_response，UI 据此展示空响应文案。
        let reason = if self.empty_completion {
            "empty_model_response"
        } else {
            self.reason
        };
        let mut error = serde_json::json!({"code": self.code, "message": self.message,
            "recoverable": self.retryable, "at": now, "source": "provider",
            "attribution": {"source": "provider", "reason": reason, "providerId": provider,
                "modelId": model, "retryable": self.retryable}});
        if let Some(status) = self.status_code {
            error["attribution"]["statusCode"] = status.into();
        }
        error
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryState {
    pub attempt: u32,
    pub max_attempts: u32,
    pub next_retry_at: u64,
    pub reason_code: &'static str,
}
