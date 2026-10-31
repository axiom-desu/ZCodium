//! Definite argument failures, classified by the existing decoder/parser only.
//! This diagnostic is not a schema validator and owns no admission policy or IO.
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputValidationError {
    message: String,
}

impl InputValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// Keep both the readable cause and the original typed error/source chain.
    pub fn caused_by(error: impl Into<anyhow::Error>) -> anyhow::Error {
        let error = error.into();
        let diagnostic = Self::new(error.to_string());
        error.context(diagnostic)
    }
}

impl fmt::Display for InputValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for InputValidationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn todo_decoder_and_parser_classify_only_their_input_failures() {
        for args in [
            json!({"todos":"[]"}),
            json!({"todos":[{"content":"","status":"pending","priority":"high"}]}),
        ] {
            let error = crate::todo::parse("TodoWrite", args).unwrap_err();
            assert!(error.is::<InputValidationError>(), "{error:#}");
        }
        let error = crate::todo::parse("TodoWrite", json!({"todos":"[]"})).unwrap_err();
        assert!(
            error.is::<serde_json::Error>(),
            "original serde error survives"
        );
        assert_eq!(error.root_cause().to_string(), error.to_string());
        assert!(crate::todo::parse("TodoWrite", json!({"todos":[]})).is_ok());
        assert!(
            crate::todo::parse("TodoRead", json!({"extra":1}))
                .unwrap_err()
                .is::<InputValidationError>()
        );
    }

    #[test]
    fn plan_validator_retains_limits_and_reports_typed_failure() {
        let error: anyhow::Error = crate::plan_mode::exit_plan(&json!({"plan":4}))
            .unwrap_err()
            .into();
        assert!(error.is::<InputValidationError>());
        assert_eq!(error.to_string(), "plan: Invalid input: expected string");
        assert!(crate::plan_mode::exit_plan(&json!({"plan":"x".repeat(20_001)})).is_err());
        assert!(crate::plan_mode::exit_plan(&json!({"plan":"ok", "extra":true})).is_ok());
    }

    #[test]
    fn response_json_failure_is_not_an_input_diagnostic() {
        let response = serde_json::from_str::<serde_json::Value>("not JSON").unwrap_err();
        let error = anyhow::Error::new(response);
        assert!(!error.is::<InputValidationError>());
    }
}
