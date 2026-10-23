//! ToolSearch 公告的冷恢复 metadata（Node `runtimeMessageMetadataFromPartMetadata`
//! 的 `legacy_synthetic` + `toolSearchAnnouncement` 分支）。
use super::entries::metadata;
use serde_json::Value;

/// 合法的增量公告事实恢复为 `tool_search_announcement` source + 严格 delta。
pub(super) fn runtime_metadata(runtime: &Value) -> Option<Value> {
    if runtime["source"].as_str() != Some("legacy_synthetic") {
        return None;
    }
    let delta = runtime
        .get("toolSearchAnnouncement")
        .and_then(crate::tool_search::Announcement::from_value)?;
    let mut out = metadata("tool_search_announcement", None);
    out[crate::tool_search::ANNOUNCEMENT_KEY] = delta.to_value();
    Some(out)
}
