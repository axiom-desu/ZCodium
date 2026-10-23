//! workflow 续步/撤销的纯状态机回归：旧回包不得释放新 workflow。
use super::*;
use serde_json::json;

fn snapshot_flow(view: &View) -> Flow {
    Flow::Snapshot(crate::flow_snapshot::Snapshot::new(view).unwrap())
}

#[test]
fn stale_flow_reply_never_releases_the_new_workflow_in_the_same_slot() {
    let mut view = View {
        session: "s".into(),
        ..View::default()
    };
    let mut flows = Continuations::default();
    assert!(flows.begin(&view, snapshot_flow(&view)));
    let old = flows.take_staged().expect("old first step");
    // 模拟旧世代被撤销：槽位释放，但旧回包仍可能稍后到达。
    flows.drop_slot(Slot::Read);
    assert!(flows.begin(&view, snapshot_flow(&view)));
    let new = flows.take_staged().expect("new first step");
    assert_ne!(old.epoch, new.epoch);

    // 迟到的旧 epoch 回包：必须先校验身份，不能 take 掉新 workflow。
    let effects = flows.resume(
        &mut view,
        Slot::Read,
        old.epoch,
        old.generation,
        Ok(json!({"snapshot":{}})),
    );
    assert!(!effects.dirty);
    assert!(flows.busy(Slot::Read), "旧 reply 不得释放当前新 workflow");
    // 新 workflow 仍可正常接收自己的回包。
    let effects = flows.resume(
        &mut view,
        Slot::Read,
        new.epoch,
        new.generation,
        Ok(json!({"snapshot":{}})),
    );
    assert!(effects.dirty);
    assert!(!flows.busy(Slot::Read));
}

#[test]
fn invalidate_reports_user_visible_flows_without_touching_current_generation() {
    let view = View {
        session: "old".into(),
        ..View::default()
    };
    let mut flows = Continuations::default();
    assert!(flows.begin(&view, snapshot_flow(&view)));
    let staged = flows.take_staged().expect("step");
    // 同一世代：不得撤销。
    assert!(flows.invalidate(view.generation).is_empty());
    assert!(flows.busy(Slot::Read));
    // 新世代：撤销并报告类型，供调用方显式提示。
    let dropped = flows.invalidate(view.generation.wrapping_add(1));
    assert_eq!(dropped, vec![Pending::Syncing]);
    assert!(!flows.busy(Slot::Read));
    let _ = staged;
}
