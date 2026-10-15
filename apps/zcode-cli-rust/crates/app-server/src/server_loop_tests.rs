//! Full `serve` loop: resume projection per profile (spec cli-rust-m6-stdio §3).
use super::harness::*;
use super::*;

#[tokio::test]
async fn resume_subscribe_keeps_range_and_online_input_only_for_both_profiles() {
    checked(async {
        for profile in PROFILES {
            let mut h = Harness::start().await;
            let state = resume(
                "e",
                6,
                4,
                vec![
                    delta("text", "a"),
                    delta("inputText", "i"),
                    delta("text", "b"),
                ],
            );
            let batch = h
                .subscribe("resume", profile, json!({"mode":"resume","from":4}), state)
                .await;
            // ACK 先于 initial，两者关联同一次 subscribe 的 subscriptionId。
            assert_eq!(batch.len(), 2);
            let sub = ack(&batch, "resume", "resume").to_owned();
            let payload = frame(&batch[1], &sub, "initial", (4, 6));
            // profile 只过滤 deltas，不改写 (fromSeq,toSeq]。
            let expected = if profile == PROFILES[0] {
                json!([
                    delta("text", "a"),
                    delta("inputText", "i"),
                    delta("text", "b"),
                ])
            } else {
                json!([delta("text", "ab")])
            };
            assert_eq!(payload["deltas"], expected);

            // 在线区间只有 inputText：replayable 过滤后仍要发 (6,7] 空 deltas 保连续。
            h.batch(vec![event(6, 7, vec![delta("inputText", "x")])])
                .await;
            let online = h.output().await;
            let payload = frame(&online[0], &sub, "online", (6, 7));
            let expected = if profile == PROFILES[0] {
                json!([delta("inputText", "x")])
            } else {
                json!([])
            };
            assert_eq!(payload["deltas"], expected);
            assert!(h.finish().await.is_empty());
        }
    })
    .await;
}
