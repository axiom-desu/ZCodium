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
