//! Full `serve` loop: gap repair and explicit resync (spec cli-rust-m6-stdio §2–3).
use super::harness::*;
use super::*;

#[tokio::test]
async fn seq_gap_routes_topic_snapshot_and_reply_covers_in_flight_deltas() {
    checked(async {
        let mut h = Harness::start().await;
        let batch = h
            .subscribe("sub", PROFILES[0], json!({"mode":"snapshot"}), snapshot(4))
            .await;
        let sub = ack(&batch, "sub", "snapshot").to_owned();
        frame(&batch[1], &sub, "initial", (0, 4));

        // 序号断档时不能输出伪连续 delta，必须向 runtime 路由 TopicSnapshot。
        h.batch(vec![event(9, 10, vec![delta("text", "lost")])])
            .await;
        let (token, params) = h.routed(Method::TopicSnapshot).await;
        assert_eq!(params, json!({"topic":TOPIC}));

        // 快照回复在途期间到达的增量由回复覆盖，不再单独成帧。
        h.batch(vec![event(10, 11, vec![delta("text", "in-flight")])])
            .await;
        h.reply(token, snapshot(11)).await;
        let recovered = h.output().await;
        let payload = frame(&recovered[0], &sub, "online", (0, 11));
        assert_eq!(payload["kind"], "snapshot");
        assert_eq!(payload["snapshot"], json!({"seq":11,"rows":[]}));

        // 快照落地后增量从 snapshot seq 继续，区间不重叠也不断档。
        h.batch(vec![event(11, 12, vec![delta("text", "next")])])
            .await;
        let online = h.output().await;
        let payload = frame(&online[0], &sub, "online", (11, 12));
        assert_eq!(payload["deltas"], json!([delta("text", "next")]));
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn explicit_resync_checks_ownership_and_acks_before_aligned_recovery() {
    checked(async {
        let mut h = Harness::start().await;
        let batch = h
            .subscribe("sub", PROFILES[0], json!({"mode":"snapshot"}), snapshot(4))
            .await;
        let sub = ack(&batch, "sub", "snapshot").to_owned();
        frame(&batch[1], &sub, "initial", (0, 4));

        // owner 校验：connection 不符即拒绝，且不向 runtime 路由任何请求。
        let denied = json!({
            "subscriptionId":sub,"topic":TOPIC,"connectionId":"other","base":{"from":4},
        });
        h.rpc("bad", "v4/conversation/resync", denied).await;
        let output = h.output().await;
        assert_eq!(output[0]["id"], "bad");
        assert_eq!(output[0]["error"]["message"], "fault.subscription.notOwned");

        // 显式 resync 只路由 TopicSnapshot；回复先 ACK 再 recovery 帧。
        let base = json!({"from":4});
        let request = json!({
            "subscriptionId":sub,"topic":TOPIC,"connectionId":"c","base":base,
        });
        h.rpc("good", "v4/conversation/resync", request).await;
        let (token, params) = h.routed(Method::TopicSnapshot).await;
        assert_eq!(
            params,
            json!({"topic":TOPIC,"base":base,"forceSnapshot":null})
        );

        // 已对齐的 resume 回复仍发 (4,4] recovery 帧，收口客户端在途恢复。
        h.reply(token, resume("e", 4, 4, vec![])).await;
        let recovered = h.output().await;
        assert_eq!(recovered[0]["id"], "good");
        assert_eq!(
            recovered[0]["result"]["ack"]["subscriptionId"],
            sub.as_str()
        );
        assert_eq!(recovered[0]["result"]["ack"]["mode"], "resume");
        let payload = frame(&recovered[1], &sub, "recovery", (4, 4));
        assert_eq!(payload["deltas"], json!([]));
        assert!(h.finish().await.is_empty());
    })
    .await;
}

#[tokio::test]
async fn explicit_resync_encoding_failure_recovers_via_next_flush_for_both_profiles() {
    checked(async {
        for profile in PROFILES {
            let mut h = Harness::start().await;
            let batch = h
                .subscribe("sub", profile, json!({"mode":"snapshot"}), snapshot(4))
                .await;
            let sub = ack(&batch, "sub", "snapshot").to_owned();
            frame(&batch[1], &sub, "initial", (0, 4));

            let base = json!({"from":4});
            h.rpc(
                "resync",
                "v4/conversation/resync",
                json!({"subscriptionId":sub,"topic":TOPIC,"connectionId":"c","base":base}),
            )
            .await;
            let (token, _) = h.routed(Method::TopicSnapshot).await;
            // 真实 16 MiB assembly 超限触发 resync 回复编码失败，只回错误。
            let huge = "x".repeat(crate::codec::MAX_ASSEMBLY_BYTES + 1);
            h.reply(
                token,
                json!({"epoch":"e","seq":5,"mode":"snapshot","snapshot":{"payload":huge}}),
            )
            .await;
            let failed = h.output().await;
            assert_eq!(failed.len(), 1, "encoding failure returns no frame");
            assert_eq!(failed[0]["id"], "resync");
            assert_eq!(failed[0]["error"]["code"], -32603);

            // 失败后不得永久停订阅：下一次 flush 再向 runtime 请求 TopicSnapshot。
            let (recover, params) = h.routed(Method::TopicSnapshot).await;
            assert_eq!(params, json!({"topic":TOPIC}));
            h.reply(recover, snapshot(5)).await;
            let recovered = h.output().await;
            let payload = frame(&recovered[0], &sub, "online", (0, 5));
            assert_eq!(payload["kind"], "snapshot");

            // 恢复后增量继续从新 seq 前进。
            h.batch(vec![event(5, 6, vec![delta("text", "next")])])
                .await;
            let online = h.output().await;
            let payload = frame(&online[0], &sub, "online", (5, 6));
            assert_eq!(payload["deltas"], json!([delta("text", "next")]));
            assert!(h.finish().await.is_empty());
        }
    })
    .await;
}

#[tokio::test]
async fn resync_owner_mismatches_are_rejected_without_routing_to_runtime() {
    checked(async {
        let mut h = Harness::start().await;
        let batch = h
            .subscribe("sub", PROFILES[0], json!({"mode":"snapshot"}), snapshot(4))
            .await;
        let sub = ack(&batch, "sub", "snapshot").to_owned();
        frame(&batch[1], &sub, "initial", (0, 4));

        // 三种 owner mismatch 都以 notOwned 拒绝；base 带 probe 标记，若被错误路由会在
        // 后续 `routed` 的 params 断言中暴露以证明未向 runtime 转发。
        for (id, request) in [
            (
                "bad-connection",
                json!({"subscriptionId":sub,"topic":TOPIC,"connectionId":"other","base":{"probe":"connection"}}),
            ),
            (
                "bad-topic",
                json!({"subscriptionId":sub,"topic":"conversation/other","connectionId":"c","base":{"probe":"topic"}}),
            ),
            (
                "bad-subscription",
                json!({"subscriptionId":"sub-missing","topic":TOPIC,"connectionId":"c","base":{"probe":"subscription"}}),
            ),
        ] {
            h.rpc(id, "v4/conversation/resync", request).await;
            let denied = h.output().await;
            assert_eq!(denied[0]["id"], id);
            assert_eq!(denied[0]["error"]["message"], "fault.subscription.notOwned");
        }

        // 合法请求的 TopicSnapshot 必须是 runtime 收到的第一个请求，base 为真实值。
        let base = json!({"from":4});
        h.rpc(
            "good",
            "v4/conversation/resync",
            json!({"subscriptionId":sub,"topic":TOPIC,"connectionId":"c","base":base}),
        )
        .await;
        let (token, params) = h.routed(Method::TopicSnapshot).await;
        assert_eq!(
            params,
            json!({"topic":TOPIC,"base":base,"forceSnapshot":null})
        );
        h.reply(token, resume("e", 4, 4, vec![])).await;
        let recovered = h.output().await;
        assert_eq!(recovered[0]["id"], "good");
        assert_eq!(
            recovered[0]["result"]["ack"]["subscriptionId"],
            sub.as_str()
        );
        frame(&recovered[1], &sub, "recovery", (4, 4));
        assert!(h.finish().await.is_empty());
    })
    .await;
}
