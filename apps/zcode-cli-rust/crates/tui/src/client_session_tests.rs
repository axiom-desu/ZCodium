use crate::{
    client::Client,
    projection_tests::{delta, request, view},
    session,
    transport::Resume,
};
use serde_json::json;
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, RuntimeError, RuntimeEvent, ServerMsg};

#[tokio::test]
async fn matching_reply_does_not_drop_events_before_or_after_in_the_same_batch() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request { token, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        output.send(vec![delta(0,1,json!({"op":"row.appended","row":{"rowId":"a","kind":"assistantText","text":"before"}})),ServerMsg::Reply{token,result:Ok(json!({"ok":true}))},delta(1,2,json!({"op":"state.updated","patch":{"pendingInteractions":[{"interactionId":"after"}]}}))]).await.unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    assert_eq!(
        c.call(&mut v, zcode_cli_core_api::Method::SessionList, json!({}))
            .await
            .unwrap()["ok"],
        true
    );
    assert_eq!(v.rows[0]["text"], "before");
    let event = c.next().await.unwrap();
    c.observe(&mut v, event).await.unwrap();
    assert_eq!(v.interaction().unwrap()["interactionId"], "after");
    actor.await.unwrap();
}
#[tokio::test]
async fn topic_closed_clears_busy_projection_and_allows_new_session() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request {
            token: create_token,
            method,
            ..
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::SessionCreate);
        output
            .send(vec![ServerMsg::Reply {
                token: create_token,
                result: Ok(json!({"session":{"sessionId":"new"},"settings":{}})),
            }])
            .await
            .unwrap();
        let ClientMsg::Request {
            token: open_token,
            method,
            ..
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::TopicOpen);
        output.send(vec![ServerMsg::Reply { token:open_token, result:Ok(json!({"snapshot":{"sessionId":"new","seq":0,"rows":{"window":[]},"control":{"canStop":false},"config":{"mode":"build"},"pendingInteractions":[]}})) }]).await.unwrap();
        assert!(matches!(
            input.recv().await,
            Some(ClientMsg::TopicReleased { .. })
        ));
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    v.state["control"]["canStop"] = true.into();
    v.state["pendingInteractions"] = json!([{"interactionId":"old"}]);
    v.pending_submit = true;
    c.observe(
        &mut v,
        ServerMsg::Event(RuntimeEvent::TopicClosed {
            topic: "conversation/s".into(),
        }),
    )
    .await
    .unwrap();
    assert!(!v.busy());
    assert!(v.interaction().is_none());
    session::open(&mut c, &mut v, &request(), Resume::New)
        .await
        .unwrap();
    assert_eq!(v.session, "new");
    actor.await.unwrap();
}

#[tokio::test]
async fn explicit_mode_overrides_resumed_session() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::SessionResume);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({"session":{"sessionId":"restored"},"settings":{}})),
            }])
            .await
            .unwrap();
        let ClientMsg::Request {
            token,
            method,
            params,
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::SessionSetMode);
        assert_eq!(params["mode"], "plan");
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({})),
            }])
            .await
            .unwrap();
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::TopicOpen);
        output.send(vec![ServerMsg::Reply { token, result:Ok(json!({"snapshot":{"sessionId":"restored","seq":0,"rows":{"window":[]},"control":{"canStop":false},"config":{"mode":"plan"},"pendingInteractions":[]}})) }]).await.unwrap();
        assert!(matches!(
            input.recv().await,
            Some(ClientMsg::TopicReleased { .. })
        ));
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    let mut req = request();
    req.mode_override = Some("plan".into());
    session::open(&mut c, &mut v, &req, Resume::Id("restored".into()))
        .await
        .unwrap();
    actor.await.unwrap();
    assert_eq!(v.state["config"]["mode"], "plan");
}

#[tokio::test]
async fn rejected_admission_releases_only_the_optimistic_overlay() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    tokio::spawn(async move {
        let ClientMsg::Request { token, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({"status":"rejected","reasonCode":"busy"})),
            }])
            .await
            .unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    session::submit(&mut c, &mut v, &request(), "hello")
        .await
        .unwrap();
    assert!(v.pending_submit);
    crate::frontend_test_support::complete(&mut c, &mut v).await;
    assert!(!v.pending_submit);
    assert!(v.rows.is_empty());
    assert_eq!(v.editor.text(), "hello");
}
#[tokio::test]
async fn host_only_requests_are_declined_not_fabricated_as_permission_acceptance() {
    let (to, mut input) = mpsc::channel(4);
    let (_output, mut from) = mpsc::channel(4);
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    c.observe(
        &mut v,
        ServerMsg::HostRequest {
            id: "auth".into(),
            method: "auth",
            params: json!({}),
        },
    )
    .await
    .unwrap();
    let ClientMsg::HostReply { id, result } = input.recv().await.unwrap() else {
        panic!()
    };
    assert_eq!(id, "auth");
    assert!(result.is_null());
}
#[tokio::test]
async fn model_setter_uses_runtime_validation_and_preserves_session_on_error() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    tokio::spawn(async move {
        let ClientMsg::Request {
            token,
            method,
            params,
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, zcode_cli_core_api::Method::SessionSetModel);
        assert_eq!(params["model"]["providerId"], "provider");
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Err(RuntimeError::InvalidParams("unknown model".into())),
            }])
            .await
            .unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    // 非阻塞：setter 只登记 workflow；运行时校验结果由同一 poll 结算成明确错误。
    assert!(
        !session::slash(&mut c, &mut v, &request(), "/model provider missing none")
            .await
            .unwrap()
    );
}
