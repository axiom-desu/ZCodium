//! 失败请求 usage 的账本规则（Node `model_request_failed.usage`）。
use super::*;

#[test]
fn terminal_failure_records_provider_usage_once_without_double_counting() {
    // Node：失败响应里已报告的 usage 随终止 `model_request_failed` 入账一次；
    // 重试中的失败事件不带 usage，随后的成功只有一次 `model_request_completed`。
    let mut run = RunUsage::new(who(false), 0);
    run.on_status(
        &status("model_request_started", "main_turn", json!({})),
        &ids(None),
        span,
        1,
    );
    // 空输出上下文超窗：带 usage 的终止失败。
    let usage = json!({"inputTokens": 120000, "outputTokens": 0, "totalTokens": 120000});
    let failed = json!({"retryable": false, "reason": "context_exceeded", "usage": usage});
    let facts = run.on_status(
        &status("model_request_failed", "main_turn", failed),
        &ids(None),
        span,
        2,
    );
    let fact = model(&facts[0]);
    assert_eq!(fact.status, "error");
    assert!(fact.context_exceeded);
    assert_eq!(fact.tokens, Tokens::from_usage(&usage));
    assert_eq!(fact.raw_usage.as_ref(), Some(&usage));
    // 同一次逻辑请求不会再产出第二个事实。
    assert!(
        run.on_status(
            &status(
                "model_request_completed",
                "main_turn",
                json!({"usage": usage})
            ),
            &ids(None),
            span,
            3,
        )
        .is_empty()
    );
    let facts = run.finish(Outcome::Failed, None, None, 4);
    let turn = turn(&facts);
    // turn 聚合把失败请求的 usage 计入本轮，同时不与成功重复。
    assert_eq!((turn.model_request_count, turn.tokens.input), (1, 120000));
}

#[test]
fn retryable_failure_usage_is_not_counted_twice_with_success() {
    let mut run = RunUsage::new(who(false), 0);
    run.on_status(
        &status("model_request_started", "main_turn", json!({})),
        &ids(None),
        span,
        1,
    );
    // 重试中的失败不带 usage（适配层只在终止失败上附带），不能记成本。
    let retrying = json!({"retryable": true, "reason": "server_error"});
    assert!(
        run.on_status(
            &status("model_request_failed", "main_turn", retrying),
            &ids(None),
            span,
            2,
        )
        .is_empty()
    );
    let usage = json!({"inputTokens": 10, "outputTokens": 5, "totalTokens": 15});
    let facts = run.on_status(
        &status(
            "model_request_completed",
            "main_turn",
            json!({"usage": usage}),
        ),
        &ids(Some("msg_a")),
        span,
        3,
    );
    assert!(facts.is_empty(), "steps wait for ModelDone");
    let facts = run.on_model_done(Some(&json!({"content": "ok"})), &ids(Some("msg_a")));
    let fact = model(&facts[0]);
    assert_eq!(fact.status, "completed");
    assert_eq!(fact.tokens, Tokens::from_usage(&usage));
    let facts = run.finish(Outcome::Completed, None, None, 4);
    assert_eq!(turn(&facts).tokens.input, 10);
}
