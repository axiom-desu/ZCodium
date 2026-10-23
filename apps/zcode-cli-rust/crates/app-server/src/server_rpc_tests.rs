use super::harness::*;
use super::*;

#[tokio::test]
async fn serve_routes_rpc_tokens_and_keeps_notifications_response_free() {
    checked(async {
        let mut h = Harness::start().await;
        h.rpc("unknown", "missing/method", Value::Null).await;
        let unknown = h.output().await;
        assert_eq!(unknown[0]["id"], "unknown");
        assert_eq!(unknown[0]["error"]["code"], -32601);

        h.request(None, "v4/commands/query", Value::Null).await;
        let (notification, _) = h.routed(Method::CommandsQuery).await;
        h.rpc("first", "v4/commands/query", Value::Null).await;
        let (first, _) = h.routed(Method::CommandsQuery).await;
        h.rpc("second", "v4/commands/query", Value::Null).await;
        let (second, _) = h.routed(Method::CommandsQuery).await;
        h.batch(vec![
            ServerMsg::Reply {
                token: notification,
                result: Ok(json!({})),
            },
            ServerMsg::Reply {
                token: second,
                result: Ok(json!({"value":2})),
            },
            ServerMsg::Reply {
                token: first,
                result: Ok(json!({"value":1})),
            },
        ])
        .await;
        let replies = h.output().await;
        assert_eq!(
            replies,
            vec![
                json!({"id":"second","result":{"value":2}}),
                json!({"id":"first","result":{"value":1}}),
            ]
        );
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn unknown_and_duplicate_reply_tokens_produce_no_output() {
    checked(async {
        let mut h = Harness::start().await;
        h.rpc("first", "v4/commands/query", Value::Null).await;
        let (token, _) = h.routed(Method::CommandsQuery).await;
        // 未知 token 与已消费 token 的重复回复都不能产生输出。
        h.batch(vec![
            ServerMsg::Reply {
                token: token.wrapping_add(97),
                result: Ok(json!({"ghost":true})),
            },
            ServerMsg::Reply {
                token,
                result: Ok(json!({"value":1})),
            },
            ServerMsg::Reply {
                token,
                result: Ok(json!({"value":2})),
            },
        ])
        .await;
        assert_eq!(
            h.output().await,
            vec![json!({"id":"first","result":{"value":1}})]
        );
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn desktop_session_create_requests_host_preferences_before_routing() {
    checked(async {
        let mut h = Harness::start_with(ServeOptions {
            request_session_preferences: true,
        })
        .await;
        h.rpc(
            "create",
            "session/create",
            json!({"workspace":{"workspacePath":"/w","workspaceKey":"/w"}}),
        )
        .await;
        let host = h.output().await;
        assert_eq!(host.len(), 1);
        assert_eq!(host[0]["method"], "session/requestRuntimePreferences");
        assert_eq!(host[0]["params"]["scope"], "runtime-materialization");
        assert!(host[0]["params"]["sessionId"].as_str().is_some());
        h.respond(
            host[0]["id"].as_str().unwrap(),
            json!({"toolSearchMode":"local","memoryEnabled":false}),
        )
        .await;
        let (token, params) = h.routed(Method::SessionCreate).await;
        assert_eq!(params["runtimeConfig"]["toolSearch"]["mode"], "local");
        h.reply(token, json!({"sessionId":"s"})).await;
        assert_eq!(
            h.output().await,
            vec![json!({"id":"create","result":{"sessionId":"s"}})]
        );
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn old_host_preference_failure_falls_back_without_runtime_config() {
    checked(async {
        let mut h = Harness::start_with(ServeOptions {
            request_session_preferences: true,
        })
        .await;
        h.rpc("resume", "session/resume", json!({"sessionId":"s"}))
            .await;
        let host = h.output().await;
        assert_eq!(host[0]["method"], "session/requestRuntimePreferences");
        // stdio 层把 Host error 解析为 null；旧 Host/不支持时按缺省 Off 继续创建。
        h.respond(host[0]["id"].as_str().unwrap(), Value::Null)
            .await;
        let (token, params) = h.routed(Method::SessionResume).await;
        assert!(params.get("runtimeConfig").is_none());
        h.reply(token, json!({})).await;
        assert_eq!(h.output().await[0]["id"], "resume");
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn in_process_serve_keeps_routing_without_a_host_preference_request() {
    checked(async {
        let mut h = Harness::start().await;
        h.rpc("create", "session/create", json!({"workspace":{}}))
            .await;
        let (token, params) = h.routed(Method::SessionCreate).await;
        assert!(params.get("runtimeConfig").is_none());
        h.reply(token, json!({})).await;
        assert_eq!(h.output().await[0]["id"], "create");
        assert!(h.finish().await.is_empty());
    })
    .await;
}
