use serde_json::Value;

pub(super) fn stop_target_changed(expected: Option<&str>, active: Option<&str>) -> bool {
    expected.is_some_and(|target| active != Some(target))
}

pub(super) fn replay_cached_ack(mut ack: Value) -> Value {
    if ack["status"] == "accepted" {
        ack["status"] = "duplicate".into();
    }
    ack
}

pub(super) enum StopAdmission {
    Replay(Value),
    Guard,
    Proceed,
}

pub(super) fn stop_admission(
    receipt: Option<Value>,
    expected: Option<&str>,
    active: Option<&str>,
) -> StopAdmission {
    if let Some(ack) = receipt {
        return StopAdmission::Replay(replay_cached_ack(ack));
    }
    if stop_target_changed(expected, active) {
        StopAdmission::Guard
    } else {
        StopAdmission::Proceed
    }
}
