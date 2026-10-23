//! Node `session-history-hydrator.ts` 的 compact 边界 metadata 恢复。
use super::branch::truthy;
use serde_json::{Value, json};

/// Node `isActiveCompactionBoundaryPart` + `hydrateCompactDiscovery`：有效边界的
/// 发现检查点作为 summary entry 的 metadata 一并恢复。
pub(super) fn compact_boundary(parts: &[Value]) -> Option<Value> {
    let part = parts.iter().find(|part| {
        part["type"] == "compaction"
            && (truthy(part.get("compactBoundary")) || !truthy(part.get("timelineStatus")))
    })?;
    let boundary = part.get("compactBoundary")?.as_object()?;
    let boundary_id = boundary.get("boundaryId")?.as_str()?;
    let names = match boundary.get("preCompactDiscoveredTools") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| name.as_str().filter(|name| !name.is_empty()))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(json!({"boundaryId": boundary_id, "preCompactDiscoveredTools": names}))
}
