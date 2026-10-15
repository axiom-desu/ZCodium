use super::*;

#[path = "server_bridge_tests.rs"]
mod bridge_tests;
#[path = "server_harness.rs"]
mod harness;
#[path = "server_loop_tests.rs"]
mod loop_tests;
#[path = "server_recovery_tests.rs"]
mod recovery_tests;
#[path = "server_rpc_tests.rs"]
mod rpc_tests;
#[path = "server_subscribe_tests.rs"]
mod subscribe_tests;

use harness::*;

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
