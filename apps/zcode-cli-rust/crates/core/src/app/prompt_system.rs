//! 上游 3.18.2 F3：主会话 system 字节冻结。
//! 语义见 `.agents/specs/upstream-3.18-rust-context.md`。
//!
//! 记录的是**请求前缀的前 3 段 system 消息**与该请求的模型标识；命中后按记录发送，
//! 使冷恢复与升级后的前缀字节不变。它与既有 `prompt_snapshot`（首轮环境快照）不是同一事物。
use crate::contract::{Event, EventSink, ModelIdentity};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

// session_entry 类型是 `runtime/prompt_snapshot`：写入在 `node_journal`，读取在 `state`。
/// 冻结的 system 消息数：CLI 前缀、稳定身份段、动态环境段。
pub const SYSTEM_LEN: usize = 3;

/// 清除标记：compaction 成功后写，冷恢复不再复用压缩前的 system。
pub fn cleared() -> Value {
    json!({"cleared": true})
}

/// 一次记录：模型标识与冻结的 system 消息。
/// 安全修复（W4）：冻结前缀包含按思考档位生成的 system 段落，快照必须记录
/// `reasoningLevel`，否则切换档位后仍按旧档位字节发送。
pub fn build(model: Option<&ModelIdentity>, system: &[Value]) -> Value {
    json!({
        "model": model.map(|m| json!({
            "providerId": m.provider_id,
            "modelId": m.model_id,
            "reasoningLevel": m.reasoning_level,
        })),
        "system": system,
    })
}

/// 快照里冻结的 system 消息：未清除、形状合法、且请求模型与快照模型相同。
/// 模型标识缺失（provider 未给出身份）时保守地不使用快照。
pub fn matching(entry: &Value, model: Option<&ModelIdentity>) -> Option<Vec<Value>> {
    if entry["cleared"] == true {
        return None;
    }
    let system = entry["system"].as_array()?;
    if system.len() != SYSTEM_LEN
        || !system
            .iter()
            .all(|message| message["role"] == "system" && message["content"].is_string())
    {
        return None;
    }
    let model = model?;
    if entry["model"]["providerId"] != model.provider_id
        || entry["model"]["modelId"] != model.model_id
    {
        return None;
    }
    // 旧快照没有 reasoningLevel：按 provider+model 兼容，不因升级丢弃已绑定字节。
    if let Some(level) = entry["model"]["reasoningLevel"].as_str()
        && level != model.reasoning_level
    {
        return None;
    }
    Some(system.clone())
}

/// 主会话首个请求记录快照；写入失败不阻断请求（下一次请求会重新记录）。
pub(super) async fn record(
    sink: &EventSink,
    model: Option<&ModelIdentity>,
    system: &[Value],
    cancel: &CancellationToken,
) -> Result<()> {
    let Some(model) = model else {
        return Ok(());
    };
    let data = build(Some(model), system);
    let (committed, receipt) = oneshot::channel();
    sink.send(Event::PromptSystem { data, committed }).await?;
    tokio::select! {biased;
        _=cancel.cancelled()=>anyhow::bail!("Cancelled"),
        result=receipt=>result.context("Prompt system snapshot commit failed")?,
    }
    Ok(())
}

/// 请求前缀里的前 3 段 system 消息（不含 meta-user 日期块）。
/// 只取**开头连续**的 system 段：模板/前缀形状变化后，不能把后面的 system
/// 消息误当成冻结段（W4 的 splice 边界）。
pub fn system_messages(prefix: &[Value]) -> Vec<Value> {
    prefix
        .iter()
        .take_while(|message| is_system(message))
        .take(SYSTEM_LEN)
        .cloned()
        .collect()
}

fn is_system(message: &Value) -> bool {
    message["role"] == "system" && message["content"].is_string()
}

/// splice 前再次断言：只有前缀开头恰好 `SYSTEM_LEN` 条 system 时才替换。
pub fn spliceable(prefix: &[Value]) -> bool {
    prefix.len() >= SYSTEM_LEN && prefix[..SYSTEM_LEN].iter().all(is_system)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ModelIdentity {
        ModelIdentity {
            provider_id: "anthropic".into(),
            model_id: "claude".into(),
            reasoning_level: "high".into(),
        }
    }

    fn system() -> Vec<Value> {
        (0..SYSTEM_LEN)
            .map(|index| json!({"role": "system", "content": format!("s{index}")}))
            .collect()
    }

    #[test]
    fn a_snapshot_matches_only_its_own_model_and_never_after_clearing() {
        let data = build(Some(&identity()), &system());
        assert_eq!(
            matching(&data, Some(&identity())).unwrap().len(),
            SYSTEM_LEN
        );
        let other = ModelIdentity {
            model_id: "other".into(),
            ..identity()
        };
        assert!(matching(&data, Some(&other)).is_none());
        // W4：provider/model 相同但思考档位不同，不能复用旧档位的冻结 system。
        let level = ModelIdentity {
            reasoning_level: "low".into(),
            ..identity()
        };
        assert!(matching(&data, Some(&level)).is_none());
        assert!(matching(&data, None).is_none());
        assert!(matching(&cleared(), Some(&identity())).is_none());
    }

    #[test]
    fn a_legacy_snapshot_without_reasoning_level_still_matches() {
        let mut data = build(Some(&identity()), &system());
        data["model"]
            .as_object_mut()
            .unwrap()
            .remove("reasoningLevel");
        assert!(matching(&data, Some(&identity())).is_some());
    }

    #[test]
    fn splicing_requires_the_frozen_leading_system_shape() {
        assert!(spliceable(&system()));
        let mut changed = system();
        changed[1] = json!({"role": "user", "content": "x"});
        assert!(!spliceable(&changed));
        assert!(system_messages(&changed).len() == 1);
        assert!(!spliceable(&system()[..2]));
    }

    #[test]
    fn an_invalid_snapshot_is_treated_as_absent() {
        let data = build(Some(&identity()), &system()[..1]);
        assert!(matching(&data, Some(&identity())).is_none());
        let not_system = json!({"model": {"providerId": "anthropic", "modelId": "claude"},
            "system": [{"role": "user", "content": "x"}, {"role": "system", "content": "y"},
                {"role": "system", "content": "z"}]});
        assert!(matching(&not_system, Some(&identity())).is_none());
        assert!(matching(&json!({"cleared": false}), Some(&identity())).is_none());
    }

    #[test]
    fn system_messages_take_only_the_frozen_leading_system_prompt() {
        let prefix = vec![
            json!({"role": "system", "content": "a"}),
            json!({"role": "system", "content": "b"}),
            json!({"role": "system", "content": "c"}),
            json!({"role": "user", "content": "<system-reminder>date</system-reminder>"}),
        ];
        let messages = system_messages(&prefix);
        assert_eq!(messages.len(), SYSTEM_LEN);
        assert_eq!(messages[2]["content"], "c");
    }
}
