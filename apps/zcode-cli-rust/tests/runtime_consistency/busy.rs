// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

pub(super) async fn busy_fixture() -> (Runtime, String, ToolStart) {
    busy_fixture_with("Read").await
}
pub(super) async fn busy_fixture_with(name: &str) -> (Runtime, String, ToolStart) {
    let (tx, mut tools) = mpsc::unbounded_channel();
    let mut runtime = start(vec![call(0, name)], Some(tx)).await;
    let first = receive(&mut runtime.commits).await;
    let id = first.session_id.clone();
    first.permit.send(true).unwrap();
    for _ in 0..3 {
        receive(&mut runtime.commits)
            .await
            .permit
            .send(true)
            .unwrap();
    }
    let tool = receive(&mut tools).await;
    (runtime, id, tool)
}
pub(super) async fn send_busy(runtime: &Runtime, id: &str, delivery: &str) {
    let request = serde_json::from_value(json!({"id":2,"method":"v4/command","params":{
        "commandId":"busy", "clientId":"test", "sessionId":id, "type":"sendText", "issuedAt":1000,
        "payload":{"text":"new input", "requestedDelivery":delivery}
    }}))
    .unwrap();
    runtime.input.send(Input::Request(request)).await.unwrap();
}
pub(super) async fn finish_success(mut runtime: Runtime) {
    loop {
        let commit = receive(&mut runtime.commits).await;
        let done = commit.phase == "completedSuccess";
        commit.permit.send(true).unwrap();
        if done {
            break;
        }
    }
    runtime.input.send(Input::Eof).await.unwrap();
    runtime.running.await.unwrap().unwrap();
}
