//! MCP response taxonomy: only tools/call InvalidParams is definite input failure.
use crate::contract::{InputValidationError, ToolError};
use rmcp::{model::ErrorCode, service::ServiceError};

pub(super) fn response(error: ServiceError, closed: bool, tool_call: bool) -> anyhow::Error {
    // 只信协议数值码，不按服务端文案/JSON 解码失败猜参数错误；原 SDK cause 保留。
    if tool_call
        && matches!(&error, ServiceError::McpError(data) if data.code == ErrorCode::INVALID_PARAMS)
    {
        return InputValidationError::caused_by(error);
    }
    let error = anyhow::Error::new(error);
    if closed {
        error.context(ToolError::Sdk {
            code: "CONNECTION_CLOSED",
            message: "Connection closed".into(),
        })
    } else {
        error.context("MCP request failed or timed out")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ErrorData;
    use serde_json::json;

    #[test]
    fn only_call_invalid_params_is_typed_and_preserves_protocol_cause() {
        let error = response(
            ServiceError::McpError(ErrorData::invalid_params(
                "count must be numeric",
                Some(json!({"field":"count"})),
            )),
            false,
            true,
        );
        assert!(error.is::<InputValidationError>());
        let source = error.downcast_ref::<ServiceError>().unwrap();
        assert!(
            matches!(source, ServiceError::McpError(data) if data.code == ErrorCode::INVALID_PARAMS && data.data == Some(json!({"field":"count"})))
        );
        assert!(error.to_string().contains("count must be numeric"));
    }

    #[test]
    fn identical_text_internal_error_network_and_list_errors_are_not_input_failures() {
        for (data, closed, tool_call) in [
            (
                ErrorData::internal_error("InputValidationError -32602", None),
                false,
                true,
            ),
            (
                ErrorData::invalid_params("InvalidParams", None),
                false,
                false,
            ),
            (
                ErrorData::internal_error("Connection closed", None),
                true,
                true,
            ),
        ] {
            let error = response(ServiceError::McpError(data), closed, tool_call);
            assert!(!error.is::<InputValidationError>());
            assert!(error.is::<ServiceError>());
        }
        let error = response(ServiceError::TransportClosed, true, true);
        assert!(!error.is::<InputValidationError>());
        assert!(matches!(
            error.downcast_ref::<ToolError>(),
            Some(ToolError::Sdk {
                code: "CONNECTION_CLOSED",
                ..
            })
        ));
    }
}
