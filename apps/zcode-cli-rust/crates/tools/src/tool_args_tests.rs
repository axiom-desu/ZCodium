//! Existing argument-reader semantics; only definite errors gain a typed tag.
use super::tool_args::*;
use crate::contract::InputValidationError;
use serde_json::json;

#[test]
fn readers_tag_wrong_types_keys_and_paths_without_adding_checks() {
    let args = json!({"s":4,"n":-1,"b":"not boolean"});
    for error in [
        string(&args, "s").unwrap_err(),
        uint(&args, "n", 5).unwrap_err(),
        boolean(&args, "b", false).unwrap_err(),
        keys(&args, &["s", "n"]).unwrap_err(),
        keys(&json!([]), &[]).unwrap_err(),
        resolve(std::path::Path::new("/w"), "").unwrap_err(),
    ] {
        assert!(error.is::<InputValidationError>(), "{error:#}");
    }
    assert_eq!(
        string(&args, "s").unwrap_err().to_string(),
        "s must be a string"
    );
    assert_eq!(uint(&json!({}), "n", 5).unwrap(), 5);
    assert!(boolean(&json!({"b":"yes"}), "b", false).unwrap());
    assert!(!boolean(&json!({"b":0}), "b", true).unwrap());
    assert!(keys(&json!({"s":"ok"}), &["s"]).is_ok());
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    assert!(
        !check_cancel(&cancel)
            .unwrap_err()
            .is::<InputValidationError>()
    );
}
