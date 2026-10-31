use super::parse;
use serde_json::json;

#[test]
fn params_are_strict_and_deduplicate_in_request_order() {
    let p = parse(&json!({"workspaceId":"/w","sessionIds":["a","b","a"]})).unwrap();
    assert_eq!(p.workspace_id, "/w");
    assert_eq!(p.session_ids, ["a", "b"]);
    assert!(parse(&json!({"workspaceId":"/w","sessionIds":[],"limit":1})).is_err());
    assert!(parse(&json!({"workspaceId":"/w","sessionIds":[""]})).is_err());
    assert!(parse(&json!({"workspaceId":"","sessionIds":[]})).is_err());
}

#[test]
fn params_reject_more_than_the_frame_budget() {
    let ids = (0..257).map(|i| format!("s{i}")).collect::<Vec<_>>();
    assert!(parse(&json!({"workspaceId":"/w","sessionIds":ids})).is_err());
}
