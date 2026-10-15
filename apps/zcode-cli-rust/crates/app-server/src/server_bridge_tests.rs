//! Full `serve` loop: host bridge and stdin framing outcomes (spec cli-rust-m6-stdio §1–2).
use super::harness::*;
use super::*;

#[tokio::test]
async fn serve_bridges_host_messages_and_input_responses() {
    checked(async {
        let mut h = Harness::start().await;
        // HostRequest/HostNotification 原样投影到 sink，不需要 runtime 回复。
        h.batch(vec![
            ServerMsg::HostRequest {
                id: "h1".into(),
                method: "auth/credentials",
                params: json!({"session":"s"}),
            },
            ServerMsg::HostNotification {
                method: "host/log",
                params: json!({"level":"info"}),
            },
        ])
        .await;
        let output = h.output().await;
        assert_eq!(
            output[0],
            json!({"id":"h1","method":"auth/credentials","params":{"session":"s"}})
        );
        assert_eq!(
            output[1],
            json!({"method":"host/log","params":{"level":"info"}})
        );

        // Client Input::Response 走 HostReply 回 runtime，不产生协议输出。
        h.input
            .send(Input::Response {
                id: "h1".into(),
                result: json!({"token":"t"}),
            })
            .await
            .unwrap();
        assert!(matches!(
            h.requests.recv().await,
            Some(ClientMsg::HostReply { id, result }) if id == "h1" && result == json!({"token":"t"})
        ));
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn close_drains_more_batches_than_the_sink_capacity() {
    checked(async {
        let mut h = Harness::start().await;
        // 超过 sink 通道容量（32）的 batch 不读取：先 join 后 drain 会与 serve 的
        // output 发送互等死锁，close 必须先并发 drain。
        for i in 0..40 {
            h.batch(vec![ServerMsg::HostNotification {
                method: "host/log",
                params: json!({"i":i}),
            }])
            .await;
        }
        let output = h.close().await;
        assert_eq!(output.len(), 40);
    })
    .await;
}

#[tokio::test]
async fn invalid_input_keeps_loop_and_oversize_is_the_unique_eof() {
    checked(async {
        let mut h = Harness::start().await;
        // Invalid 之后同一 stdin 的合法请求仍会被路由。
        h.input.send(Input::Invalid).await.unwrap();
        let invalid = h.output().await;
        assert_eq!(invalid[0]["id"], "invalid-message");
        assert_eq!(invalid[0]["error"]["code"], -32700);

        h.rpc("after", "v4/commands/query", Value::Null).await;
        let (token, _) = h.routed(Method::CommandsQuery).await;
        h.reply(token, json!({"ok":true})).await;
        assert_eq!(
            h.output().await,
            vec![json!({"id":"after","result":{"ok":true}})]
        );

        // TooLarge fail-close：唯一 Eof，之后 input_open=false 不再接收输入。
        h.input.send(Input::TooLarge).await.unwrap();
        let oversized = h.output().await;
        assert_eq!(oversized[0]["id"], "invalid-message");
        assert_eq!(oversized[0]["error"]["code"], -32600);
        h.input_eof().await;
        h.input
            .send(Input::Request(Request {
                id: None,
                method: "v4/commands/query".into(),
                params: Value::Null,
                trace: None,
            }))
            .await
            .ok();
        assert!(h.close().await.is_empty());
        assert!(
            h.requests.recv().await.is_none(),
            "input must stay closed after TooLarge"
        );
    })
    .await;
}
