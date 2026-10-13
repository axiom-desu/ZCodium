use super::*;
use crate::contract::RuntimeEvent;
use tokio::{sync::oneshot, task::JoinHandle};

const PROFILES: [&str; 2] = ["desktop-continuous", "web-remote-replayable"];
const TOPIC: &str = "conversation/s";

// 直接接入 serve 创建的 runtime transport；测试是可控 router，不绕过 loop 调用 handler。
struct Harness {
    input: mpsc::Sender<Input>,
    output: mpsc::Receiver<Vec<Value>>,
    requests: mpsc::Receiver<ClientMsg>,
    responses: mpsc::Sender<Vec<ServerMsg>>,
    stop: oneshot::Sender<()>,
    running: JoinHandle<Result<()>>,
}

impl Harness {
    async fn start() -> Self {
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
            output,
            requests,
            responses,
            stop,
            running,
        }
    }

    async fn request(&self, id: Option<RequestId>, method: &str, params: Value) {
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

    async fn rpc(&self, id: &str, method: &str, params: Value) {
        self.request(Some(RequestId::Text(id.into())), method, params)
            .await;
    }

    async fn routed(&mut self, expected: Method) -> (u64, Value) {
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

    async fn batch(&self, messages: Vec<ServerMsg>) {
        self.responses.send(messages).await.unwrap();
    }

    async fn reply(&self, token: u64, state: Value) {
        self.batch(vec![ServerMsg::Reply {
            token,
            result: Ok(state),
        }])
        .await;
    }

    async fn output(&mut self) -> Vec<Value> {
        self.output.recv().await.expect("serve output")
    }

    async fn release(&mut self) {
        assert!(matches!(self.requests.recv().await,
            Some(ClientMsg::TopicReleased { topic }) if topic == TOPIC));
    }

    async fn subscribe(
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

    async fn finish(mut self) -> Vec<Value> {
        self.input.send(Input::Eof).await.unwrap();
        assert!(matches!(self.requests.recv().await, Some(ClientMsg::Eof)));
        // serve 持有 client sender，必须显式结束 runtime，不能等待请求通道先关闭。
        drop(self.responses);
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
        let mut output = vec![];
        while let Some(batch) = self.output.recv().await {
            output.extend(batch);
        }
        assert!(self.requests.recv().await.is_none(), "EOF must be unique");
        output
    }
}

async fn checked(future: impl std::future::Future<Output = ()>) {
    // 仅作死锁失败保护；事件同步依靠 runtime / output 通道，不依靠延时。
    tokio::time::timeout(std::time::Duration::from_secs(20), future)
        .await
        .expect("serve test deadlocked");
}

fn snapshot(seq: u64) -> Value {
    json!({"epoch":"e","seq":seq,"mode":"snapshot","snapshot":{"seq":seq,"rows":[]}})
}

fn delta(path: &str, append: &str) -> Value {
    json!({"op":"row.delta","rowId":1,"path":path,"append":append})
}

fn event(from: u64, to: u64, deltas: Vec<Value>) -> ServerMsg {
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

fn ack<'a>(batch: &'a [Value], id: &str, mode: &str) -> &'a str {
    assert_eq!(batch[0]["id"], id);
    let ack = &batch[0]["result"]["ack"];
    assert_eq!(ack["mode"], mode);
    assert_eq!(ack["logEpoch"], "e");
    let subscription = ack["subscriptionId"].as_str().expect("ACK subscriptionId");
    assert!(subscription.starts_with("sub-"));
    subscription
}

fn frame<'a>(value: &'a Value, subscription: &str, kind: &str, range: (u64, u64)) -> &'a Value {
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

#[tokio::test]
async fn serve_routes_subscriptions_for_both_profiles_with_ack_before_frame() {
    checked(async {
        for profile in PROFILES {
            let mut h = Harness::start().await;
            let batch = h
                .subscribe("sub", profile, json!({"mode":"snapshot"}), snapshot(4))
                .await;
            assert_eq!(batch.len(), 2);
            let subscription = ack(&batch, "sub", "snapshot");
            let payload = frame(&batch[1], subscription, "initial", (0, 4));
            assert_eq!(
                payload,
                &json!({"kind":"snapshot","snapshot":{"seq":4,"rows":[]}})
            );
            assert!(h.finish().await.is_empty());
        }
    })
    .await;
}

#[tokio::test]
async fn failed_resubscribe_encoding_preserves_previous_subscription_and_sequence() {
    checked(async {
        for profile in PROFILES {
            let mut h = Harness::start().await;
            let batch = h
                .subscribe("first", profile, json!({"mode":"snapshot"}), snapshot(4))
                .await;
            let old = ack(&batch, "first", "snapshot").to_owned();
            assert_eq!(batch.len(), 2);
            frame(&batch[1], &old, "initial", (0, 4));
            let replacement = if profile == PROFILES[0] {
                PROFILES[1]
            } else {
                PROFILES[0]
            };
            // 使用真实 assembly 上限触发编码失败，不注入测试专用生产接口。
            let huge = "x".repeat(crate::codec::MAX_ASSEMBLY_BYTES + 1);
            let state = json!({"epoch":"e","seq":99,"mode":"snapshot","snapshot":{"payload":huge}});
            let failed = h
                .subscribe("second", replacement, json!({"mode":"snapshot"}), state)
                .await;
            assert_eq!(failed.len(), 1, "no new ACK or initial frame");
            assert_eq!(failed[0]["id"], "second");
            assert_eq!(failed[0]["error"]["code"], -32603);
            h.release().await;
            let input = delta("inputText", "still-old-profile");
            h.batch(vec![event(4, 5, vec![input.clone()])]).await;
            // runtime 关闭后 flush_final 也必须保留旧 owner / sequence / profile。
            let output = h.finish().await;
            assert_eq!(output.len(), 1);
            let payload = frame(&output[0], &old, "online", (4, 5));
            let expected = if profile == PROFILES[0] {
                vec![input]
            } else {
                vec![]
            };
            assert_eq!(payload["deltas"], json!(expected));
        }
    })
    .await;
}

#[path = "server_rpc_tests.rs"]
mod rpc_tests;
