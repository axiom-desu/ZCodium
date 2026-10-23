//! 非阻塞 mutation 票据：慢 ACK 不阻塞、通道满不丢请求、回包按票据归属分流。
use crate::{
    client::Client,
    operations::{BeginError, OpKind, SentDraft},
    projection::View,
};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, ServerMsg};

type Endpoints = (
    mpsc::Sender<ClientMsg>,
    mpsc::Receiver<ClientMsg>,
    mpsc::Sender<Vec<ServerMsg>>,
    mpsc::Receiver<Vec<ServerMsg>>,
);

fn endpoints(capacity: usize) -> Endpoints {
    let (to, requests) = mpsc::channel(capacity);
    let (responses, from) = mpsc::channel(capacity);
    (to, requests, responses, from)
}

fn view() -> View {
    View {
        session: "s1".into(),
        ..View::default()
    }
}

#[tokio::test]
async fn dispatch_sends_once_and_a_second_enter_is_rejected_without_a_second_request() {
    let (to, mut requests, _responses, mut from) = endpoints(8);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("first");
    view.operations
        .begin(
            OpKind::Submit,
            "s1",
            view.generation,
            Some(SentDraft::new("first", Default::default())),
        )
        .unwrap();

    // 非阻塞：只发送并返回票据，不等待回包（fake actor 保持不回）。
    let token = client
        .dispatch_operation(
            &view.session,
            view.generation,
            &mut view.operations,
            OpKind::Submit,
            Method::Command,
            serde_json::json!({"type":"sendText"}),
        )
        .unwrap()
        .expect("slot 空且通道有容量时立即发出");
    assert!(requests.try_recv().is_ok());
    // 慢 ACK 期间再次 Enter：明确拒绝，不重复发送。
    assert_eq!(
        view.operations
            .begin(OpKind::Submit, "s1", view.generation, None),
        Err(BeginError::Busy)
    );
    assert!(requests.try_recv().is_err(), "不能有第二次 admission");
    // 未回包前 refresh/其它只读路径也不可能拿到这份 token 的结算。
    assert!(client.take_operation_replies().is_empty());
    let _ = token;
}

#[tokio::test]
async fn full_channel_returns_none_and_releases_the_slot_without_losing_the_draft() {
    let (to, mut requests, _responses, mut from) = endpoints(1);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    // 占满唯一通道槽：真实运行期 RPC 在高负载下也会满。
    to.try_send(ClientMsg::Eof).unwrap();
    view.operations
        .begin(
            OpKind::Submit,
            "s1",
            view.generation,
            Some(SentDraft::new("keep me", Default::default())),
        )
        .unwrap();
    let result = client
        .dispatch_operation(
            &view.session,
            view.generation,
            &mut view.operations,
            OpKind::Submit,
            Method::Command,
            serde_json::json!({"type":"sendText"}),
        )
        .unwrap();
    assert!(result.is_none(), "通道满必须返回可重试的本地结果");
    // 请求没有真正发出，不代表发送成功：草稿仍可从 operation 取回。
    assert!(requests.try_recv().is_ok());
    assert_eq!(
        view.operations.inflight_draft().map(|d| d.text.as_str()),
        Some("keep me")
    );
}

#[tokio::test]
async fn reply_is_routed_to_the_operation_ticket_with_its_origin_identity() {
    let (to, mut requests, responses, mut from) = endpoints(8);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.operations
        .begin(
            OpKind::Submit,
            "s1",
            view.generation,
            Some(SentDraft::new("hi", Default::default())),
        )
        .unwrap();
    let token = client
        .dispatch_operation(
            &view.session,
            view.generation,
            &mut view.operations,
            OpKind::Submit,
            Method::Command,
            serde_json::json!({"type":"sendText"}),
        )
        .unwrap()
        .expect("channel has room");
    let sent = requests.try_recv().expect("request was sent");
    assert!(matches!(sent, ClientMsg::Request { token: t, .. } if t == token));
    responses
        .try_send(vec![ServerMsg::Reply {
            token,
            result: Ok(serde_json::json!({"status":"accepted"})),
        }])
        .unwrap();
    let message = client.next().await.unwrap();
    client.observe(&mut view, message).await.unwrap();
    let replies = client.take_operation_replies();
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].kind,
        crate::client_operations::TicketKind::Draft(OpKind::Submit)
    );
    assert_eq!(replies[0].session, "s1");
    assert_eq!(
        replies[0].epoch,
        view.operations.epoch(),
        "回包保留发起时的意图 epoch"
    );
    assert!(replies[0].result.is_ok());
    // 结算后 slot 空，可以发起下一条。
    assert_eq!(
        view.operations.accepted(
            "s1",
            view.generation,
            OpKind::Submit,
            Some(replies[0].epoch)
        ),
        crate::operations::Attribution::Match
    );
    assert!(!view.operations.busy());
}

#[test]
fn second_begin_while_a_ticket_is_in_flight_is_an_explicit_busy_rejection() {
    let mut view = view();
    view.operations
        .begin(
            OpKind::Submit,
            "s1",
            0,
            Some(SentDraft::new("a", Default::default())),
        )
        .unwrap();
    assert_eq!(
        view.operations.begin(
            OpKind::Submit,
            "s1",
            0,
            Some(SentDraft::new("b", Default::default()))
        ),
        Err(BeginError::Busy)
    );
    // 拒绝不等于替换：已发送那份仍是唯一 owner。
    assert_eq!(
        view.operations.inflight_draft().map(|d| d.text.as_str()),
        Some("a")
    );
}
