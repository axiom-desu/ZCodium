//! Full `serve` loop: subscribe registration and pin replacement (spec cli-rust-m6-stdio §2).
use super::harness::*;
use super::*;

#[tokio::test]
async fn first_subscribe_assembly_overflow_fails_without_registering() {
    checked(async {
        let mut h = Harness::start().await;
        // 真实 assembly 上限触发编码失败；不得登记订阅，也不得发 ACK/首帧。
        let huge = "x".repeat(crate::codec::MAX_ASSEMBLY_BYTES + 1);
        let state = json!({"epoch":"e","seq":9,"mode":"snapshot","snapshot":{"payload":huge}});
        let failed = h
            .subscribe("first", PROFILES[0], json!({"mode":"snapshot"}), state)
            .await;
        assert_eq!(failed.len(), 1, "no ACK and no initial frame");
        assert_eq!(failed[0]["id"], "first");
        assert_eq!(failed[0]["error"]["code"], -32603);
        // 失败路径释放本次 TopicOpen 取得的 pin。
        h.release().await;

        // 同连接同 topic 的成功订阅没有可替换的残留 owner：只产生一个新订阅。
        let batch = h
            .subscribe(
                "second",
                PROFILES[0],
                json!({"mode":"snapshot"}),
                snapshot(9),
            )
            .await;
        let sub = ack(&batch, "second", "snapshot").to_owned();
        frame(&batch[1], &sub, "initial", (0, 9));
        h.batch(vec![event(9, 10, vec![delta("text", "only")])])
            .await;
        let online = h.output().await;
        assert_eq!(online.len(), 1, "exactly one registered subscription");
        let payload = frame(&online[0], &sub, "online", (9, 10));
        assert_eq!(payload["deltas"], json!([delta("text", "only")]));
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn resubscribe_releases_old_pin_and_routes_frames_to_new_subscription() {
    checked(async {
        let mut h = Harness::start().await;
        let first = h
            .subscribe(
                "first",
                PROFILES[0],
                json!({"mode":"snapshot"}),
                snapshot(4),
            )
            .await;
        let old = ack(&first, "first", "snapshot").to_owned();
        frame(&first[1], &old, "initial", (0, 4));

        // 同连接同 topic 换 profile：首帧编码成功后才替换，并释放旧订阅的 pin。
        let second = h
            .subscribe(
                "second",
                PROFILES[1],
                json!({"mode":"snapshot"}),
                snapshot(4),
            )
            .await;
        let new = ack(&second, "second", "snapshot").to_owned();
        frame(&second[1], &new, "initial", (0, 4));
        assert_ne!(new, old);
        h.release().await;

        // 后续帧只属于新 subscriptionId，旧 owner 不再收到。
        h.batch(vec![event(4, 5, vec![delta("inputText", "x")])])
            .await;
        let online = h.output().await;
        assert_eq!(online.len(), 1);
        let payload = frame(&online[0], &new, "online", (4, 5));
        assert_eq!(
            payload["deltas"],
            json!([]),
            "replayable drops inputText but keeps seq"
        );
        assert!(h.finish().await.is_empty());
    })
    .await;
}
