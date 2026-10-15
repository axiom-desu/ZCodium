//! Shared in-memory harness for `serve` loop tests (spec cli-rust-m6-stdio).
//!
//! The test itself is the runtime router: it consumes the real `ClientMsg`
//! channel created by `serve` and answers `ServerMsg` on the real reply
//! channel, so routing, ACK ordering and delivery are exercised end to end
//! without a DTO stand-in. Every synchronization step waits on those channels
//! (or `serve`'s own flush window); no test-side sleep masks the event order.
use crate::contract::{ClientMsg, Input, Method, RuntimeEvent, ServerMsg};
use crate::{Sink, serve};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use zcode_cli_protocol::{Request, RequestId};

pub const PROFILES: [&str; 2] = ["desktop-continuous", "web-remote-replayable"];
pub const TOPIC: &str = "conversation/s";

/// One `serve` loop with the test acting as the runtime router.
pub struct Harness {
    pub input: mpsc::Sender<Input>,
    pub output: Option<mpsc::Receiver<Vec<Value>>>,
    pub requests: mpsc::Receiver<ClientMsg>,
    responses: Option<mpsc::Sender<Vec<ServerMsg>>>,
    stop: Option<oneshot::Sender<()>>,
    running: Option<JoinHandle<anyhow::Result<()>>>,
}

impl Harness {
    pub async fn start() -> Self {
        let (input, input_rx) = mpsc::channel(64);
        let (output_tx, output) = mpsc::channel(32);
        let (ready_tx, ready_rx) = oneshot::channel();
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(serve(
            move |requests, responses| async move {
                ready_tx.send((requests, responses)).ok().unwrap();
                stopped.await.unwrap();
                Ok(())
            },
            input_rx,
            Sink::Values(output_tx),
        ));
        let (requests, responses) = ready_rx.await.unwrap();
        Self {
            input,
            output: Some(output),
            requests,
            responses: Some(responses),
            stop: Some(stop),
            running: Some(running),
        }
    }

    pub async fn request(&self, id: Option<RequestId>, method: &str, params: Value) {
        self.input
            .send(Input::Request(Request {
                id,
                method: method.into(),
                params,
                trace: None,
            }))
            .await
            .unwrap();
    }

    pub async fn rpc(&self, id: &str, method: &str, params: Value) {
        self.request(Some(RequestId::Text(id.into())), method, params)
            .await;
    }

    /// The next request `serve` routed to the runtime.
    pub async fn routed(&mut self, expected: Method) -> (u64, Value) {
        let Some(ClientMsg::Request {
            token,
            method,
            params,
        }) = self.requests.recv().await
        else {
            panic!("expected routed {expected:?}");
        };
        assert_eq!(method, expected);
        (token, params)
    }

    pub async fn batch(&self, messages: Vec<ServerMsg>) {
        self.responses
            .as_ref()
            .expect("harness closed")
            .send(messages)
            .await
            .unwrap();
    }

    pub async fn reply(&self, token: u64, state: Value) {
        self.batch(vec![ServerMsg::Reply {
            token,
            result: Ok(state),
        }])
        .await;
    }

    pub async fn output(&mut self) -> Vec<Value> {
        self.output
            .as_mut()
            .expect("harness closed")
            .recv()
            .await
            .expect("serve output")
    }

    pub async fn release(&mut self) {
        assert!(matches!(self.requests.recv().await,
            Some(ClientMsg::TopicReleased { topic }) if topic == TOPIC));
    }

    /// Route one subscribe, answer `TopicOpen` with `state`, return the batch.
    pub async fn subscribe(
        &mut self,
        id: &str,
        profile: &str,
        base: Value,
        state: Value,
    ) -> Vec<Value> {
        self.rpc(
            id,
            "v4/conversation/subscribe",
            json!({
                "topic":TOPIC,"connectionId":"c","clientMode":profile,"base":base,
            }),
        )
        .await;
        let (token, params) = self.routed(Method::TopicOpen).await;
        assert_eq!(params, json!({"topic":TOPIC,"base":base}));
        self.reply(token, state).await;
        self.output().await
    }

    /// The single `ClientMsg::Eof` produced after input closes.
    pub async fn input_eof(&mut self) {
        assert!(
            matches!(self.requests.recv().await, Some(ClientMsg::Eof)),
            "expected unique Eof"
        );
    }

    /// End the runtime explicitly, then drain every buffered final frame.
    pub async fn close(&mut self) -> Vec<Value> {
        drop(self.responses.take());
        self.stop
            .take()
            .expect("harness already closed")
            .send(())
            .unwrap();
        let mut output = self.output.take().expect("harness already closed");
        // 先并发 drain 再等 running：sink 通道只有 32 个 batch，若先 join，serve 在
        // 超过 32 个 batch 时会阻塞在 output 发送上，与这里的 join 互等造成死锁。
        let drained = tokio::spawn(async move {
            let mut collected = vec![];
            while let Some(batch) = output.recv().await {
                collected.extend(batch);
            }
            collected
        });
        self.running
            .take()
            .expect("harness already closed")
            .await
            .unwrap()
            .unwrap();
        drained.await.unwrap()
    }

    /// Close stdin, require the unique Eof, then stop the runtime.
    pub async fn finish(mut self) -> Vec<Value> {
        self.input.send(Input::Eof).await.unwrap();
        self.input_eof().await;
        let output = self.close().await;
        assert!(self.requests.recv().await.is_none(), "EOF must be unique");
        output
    }
}

/// Deadlock failure guard only: event synchronization comes from the channels.
pub async fn checked(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(std::time::Duration::from_secs(20), future)
        .await
        .expect("serve test deadlocked");
}

pub fn snapshot(seq: u64) -> Value {
    json!({"epoch":"e","seq":seq,"mode":"snapshot","snapshot":{"seq":seq,"rows":[]}})
}

pub fn resume(epoch: &str, seq: u64, from: u64, deltas: Vec<Value>) -> Value {
    json!({"epoch":epoch,"seq":seq,"mode":"resume","from":from,"deltas":deltas})
}

pub fn delta(path: &str, append: &str) -> Value {
    json!({"op":"row.delta","rowId":1,"path":path,"append":append})
}

pub fn event(from: u64, to: u64, deltas: Vec<Value>) -> ServerMsg {
    ServerMsg::Event(RuntimeEvent::ConversationDeltas {
        session: "s".into(),
        from,
        to,
        deltas: deltas
            .into_iter()
            .map(|d| {
                let size = crate::domain::delivery::json_bytes(&d);
                (d, size)
            })
            .collect::<Vec<_>>()
            .into(),
        ttft: vec![],
    })
}

pub fn ack<'a>(batch: &'a [Value], id: &str, mode: &str) -> &'a str {
    assert_eq!(batch[0]["id"], id);
    let ack = &batch[0]["result"]["ack"];
    assert_eq!(ack["mode"], mode);
    assert_eq!(ack["logEpoch"], "e");
    let subscription = ack["subscriptionId"].as_str().expect("ACK subscriptionId");
    assert!(subscription.starts_with("sub-"));
    subscription
}

pub fn frame<'a>(value: &'a Value, subscription: &str, kind: &str, range: (u64, u64)) -> &'a Value {
    assert_eq!(value["method"], "v4/conversation/frame");
    let params = &value["params"];
    assert_eq!(params["subscriptionId"], subscription);
    assert_eq!(params["deliveryKind"], kind);
    let frame = &params["frame"];
    assert_eq!(frame["subscriptionId"], subscription);
    assert_eq!(frame["topic"], TOPIC);
    assert_eq!(frame["fromSeq"], range.0);
    assert_eq!(frame["toSeq"], range.1);
    &frame["payload"]
}
