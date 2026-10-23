//! 前端集成测试共用的 fake runtime 与草稿构造（仅测试编译）。
#![allow(dead_code)]
use crate::{
    client::Client, draft_attachments::DraftAttachments, projection::View, transport::Request,
    workspace_paths::Entry,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, ServerMsg};

pub(crate) fn request() -> Request {
    Request {
        workspace: json!({"path":"/ws"}),
        directory: "/ws".into(),
        mode_override: None,
        resume: crate::transport::Resume::New,
        disallowed_tools: Vec::new(),
        attachments: Vec::new(),
        locale: "en".into(),
    }
}

pub(crate) fn view() -> View {
    View {
        session: "s".into(),
        directory: "/ws".into(),
        ..View::default()
    }
}

pub(crate) fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

type Endpoints = (
    mpsc::Sender<ClientMsg>,
    mpsc::Receiver<ClientMsg>,
    mpsc::Sender<Vec<ServerMsg>>,
    mpsc::Receiver<Vec<ServerMsg>>,
);

pub(crate) fn endpoints() -> Endpoints {
    let (to, requests) = mpsc::channel(8);
    let (responses, from) = mpsc::channel(8);
    (to, requests, responses, from)
}

pub(crate) async fn next_request(requests: &mut mpsc::Receiver<ClientMsg>) -> (u64, String, Value) {
    match requests.recv().await.expect("runtime request") {
        ClientMsg::Request {
            token,
            method,
            params,
        } => (token, method.as_str().to_owned(), params),
        other => panic!("unexpected client message: {other:?}"),
    }
}

pub(crate) async fn reply(responses: &mpsc::Sender<Vec<ServerMsg>>, token: u64, result: Value) {
    responses
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(result),
        }])
        .await
        .unwrap();
}

pub(crate) async fn observe_next(client: &mut Client<'_>, view: &mut View) {
    let message = client.next().await.unwrap();
    client.observe(view, message).await.unwrap();
}

/// 测试驱动：真实异步发送后，等 fake runtime 的回包并由同一 `Frontend::poll` 结算。
pub(crate) async fn complete(client: &mut Client<'_>, view: &mut View) {
    if view.operations.busy() {
        observe_next(client, view).await;
    }
    crate::frontend::Frontend::default()
        .poll(client, view)
        .await
        .unwrap();
}

/// 测试驱动：推进同一 workflow 状态机直到 mutation 槽空，不新建第二条发送路径。
pub(crate) async fn drive(client: &mut Client<'_>, view: &mut View) {
    loop {
        while let Some(message) = client.try_next() {
            client.observe(view, message).await.unwrap();
        }
        crate::frontend::Frontend::default()
            .poll(client, view)
            .await
            .unwrap();
        if !client.mutation_flow_busy() {
            return;
        }
        let message = client.next().await.unwrap();
        client.observe(view, message).await.unwrap();
    }
}

pub(crate) fn draft_with(path: &str, bytes: u64) -> DraftAttachments {
    let mut drafts = DraftAttachments::default();
    assert_eq!(
        drafts.attach_entry(&Entry {
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            mime: "text/plain".into(),
            directory: false,
            bytes,
        }),
        crate::draft_attachments::AttachResult::Added
    );
    drafts
}
