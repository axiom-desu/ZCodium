//! Session lists over the Node `session` table (spec rust-m11-node-storage
//! §6.2): the sessions-index seed of sessions not loaded yet (Node
//! `loadStoredSessionSummaries`) and the persisted part of `session/list`
//! (Node `listSessions` with `mapSessionInfo`).
use super::sessions::{self, List, SessionRow};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{Value, json};
use zcode_cli_domain::session_kind::is_auxiliary_session_kind;
use zcode_cli_domain::session_listing::ListParams;
use zcode_cli_domain::workspace_identity::parse_remote;

/// Node `TASK_LIST_SESSION_TYPES`: the sessions the task list shows.
const TASK_LIST_SESSION_TYPES: [&str; 3] = ["interactive", "fork", "workflow_parent"];

fn task_list_types() -> Vec<String> {
    TASK_LIST_SESSION_TYPES.map(str::to_owned).to_vec()
}

/// Node `normalizeStoredTitleSource`.
fn summary_title_source(source: &str) -> &'static str {
    match source {
        "custom" => "custom",
        "default" => "default",
        _ => "generated",
    }
}

/// The sessions-index summaries of a workspace's stored sessions. A remote
/// identity matches its own sessions; a local path only sessions without one.
pub fn stored_summaries(conn: &Connection, workspace_id: &str) -> Result<Vec<Value>> {
    let remote = parse_remote(workspace_id);
    let rows = sessions::list(
        conn,
        &List {
            directory: Some(remote.map_or(workspace_id, |r| r.path).to_owned()),
            workspace_id: Some(remote.map(|_| workspace_id.to_owned())),
            task_types: task_list_types(),
            limit: Some(200),
            ..List::default()
        },
    )?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut summary = json!({"sessionId": row.id, "workspaceId": workspace_id});
            if let Some(parent) = &row.parent_id {
                summary["parentSessionId"] = parent.clone().into();
            }
            summary["title"] = row.title.clone().into();
            summary["titleSource"] = summary_title_source(&row.title_source).into();
            // Node `storedSummaryPhase`：未加载会话的历史终态只由持久 lastOutcome 派生。
            // 原因：无条件写 completedSuccess 会把历史里的失败/中断任务画成成功。
            summary["phase"] = summary_phase(row.last_outcome.as_deref()).into();
            // Node `SessionSummary.lastOutcome`：持久「上次结果」原样投影，不参与实时 phase 推导；
            // 历史缺失/未知值由 `decode` 读成 None，这里不凭空补。
            if let Some(outcome) = &row.last_outcome {
                summary["lastOutcome"] = outcome.clone().into();
            }
            summary["sessionEnded"] = true.into();
            summary["hasBackgroundWork"] = false.into();
            summary["lastActivityAt"] = row.time_updated.into();
            summary["createdAt"] = row.time_created.into();
            summary
        })
        .collect())
}

/// Node `storedSummaryPhase`: a missing outcome keeps the legacy "idle finished" phase.
fn summary_phase(last_outcome: Option<&str>) -> &'static str {
    match last_outcome {
        Some("error") => "error",
        Some("interrupted") => "completedInterrupted",
        _ => "completedSuccess",
    }
}

/// Node `mapSessionInfo` for a stored session without a live runtime.
fn session_info(row: &SessionRow, workspace: Value) -> Value {
    let mut info = json!({});
    if let Some(archived) = row.time_archived {
        info["archivedAt"] = archived.into();
    }
    info["createdAt"] = row.time_created.into();
    info["mode"] = "build".into();
    if let Some(parent) = &row.parent_id {
        info["parentSessionId"] = parent.clone().into();
    }
    if let Some(trace) = &row.trace_id {
        info["traceId"] = trace.clone().into();
    }
    info["sessionId"] = row.id.clone().into();
    info["sessionKind"] = row.task_type.clone().into();
    info["status"] = "idle".into();
    info["title"] = row.title.clone().into();
    info["titleSource"] = row.title_source.clone().into();
    info["updatedAt"] = row.time_updated.into();
    info["workspace"] = workspace;
    info
}

/// The workspace key a stored session belongs to: its identity, else its path
/// (a non-empty one), else its directory.
pub fn workspace_key(row: &SessionRow) -> &str {
    let identity = row.workspace_id.as_deref().map(str::trim).unwrap_or("");
    if !identity.is_empty() {
        return identity;
    }
    match row.path.as_deref() {
        Some(path) if !path.is_empty() => path,
        _ => &row.directory,
    }
}

/// The stored sessions `session/list` returns, in Node's order.
pub fn list(conn: &Connection, params: &ListParams) -> Result<Vec<Value>> {
    Ok(rows(conn, params)?
        .iter()
        .map(|row| {
            let workspace = match &params.workspace {
                Some(workspace) => json!(workspace),
                None => {
                    // Node `buildWorkspaceRef({ workspacePath: session.path ?? session.directory })`.
                    let path = row.path.clone().unwrap_or_else(|| row.directory.clone());
                    json!({"workspaceKey": path, "workspacePath": path})
                }
            };
            session_info(row, workspace)
        })
        .collect())
}

/// The session rows `session/list` returns, in Node's order.
pub fn rows(conn: &Connection, params: &ListParams) -> Result<Vec<SessionRow>> {
    // 显式 ID 分支的归属由 `owned` 逐行证明（父链可跨 key）；普通分页仍只按当前 key 过滤。
    if let Some(ids) = &params.session_ids {
        let mut rows = vec![];
        for id in ids {
            if let Some(row) = owned(conn, params, id)? {
                rows.push(row);
            }
        }
        return Ok(rows);
    }
    Ok(sessions::list(
        conn,
        &List {
            directory: params.workspace.as_ref().map(|w| w.workspace_path.clone()),
            limit: Some(params.limit.unwrap_or(50) as i64),
            task_types: task_list_types(),
            ..List::default()
        },
    )?
    .into_iter()
    .filter(|row| {
        params
            .workspace
            .as_ref()
            .is_none_or(|w| workspace_key(row) == w.identity())
    })
    .collect())
}

/// Node `listSessions`'s ownership proof for one persisted session.
///
/// 修复根因：原先只比较 current 行的身份，同路径下由子 runtime 写入、只带 cwd 的
/// workflow/nested 子会话永远进不了侧栏；改成路径前缀匹配又会把不同 authority 拼到一起。
/// 只有显式 ID 查询可凭持久 `parentID` 证明辅助会话归属：每层路径/显式身份严格校验，
/// 已删除、缺父、跨工作区与环一律拒绝；全程只读，不激活 runtime、不回写身份。
fn owned(conn: &Connection, params: &ListParams, id: &str) -> Result<Option<SessionRow>> {
    let Some(session) = sessions::get(conn, id)? else {
        return Ok(None);
    };
    let Some(workspace) = params.workspace.as_ref() else {
        return Ok(sessions::visible(&session).then_some(session));
    };
    let expected = workspace.identity();
    let mut visited: Vec<String> = vec![];
    let mut current = Some(session.clone());
    while let Some(row) = current {
        if !sessions::visible(&row) || visited.contains(&row.id) {
            return Ok(None);
        }
        visited.push(row.id.clone());
        let path = match row.path.as_deref() {
            Some(path) if !path.is_empty() => path,
            _ => row.directory.as_str(),
        };
        let identity = row.workspace_id.as_deref().map(str::trim).unwrap_or("");
        let key = if identity.is_empty() { path } else { identity };
        if key == expected {
            return Ok(Some(session));
        }
        // fork / workflow_parent 是独立任务：即使带 parentID 也不能沿父链改写项目归属。
        if params.session_ids.is_none()
            || !is_auxiliary_session_kind(&row.task_type)
            || row.parent_id.is_none()
            || path != workspace.workspace_path
            || (!identity.is_empty() && key != path)
        {
            return Ok(None);
        }
        current = sessions::get(conn, row.parent_id.as_deref().unwrap_or_default())?;
        if let Some(parent) = &current {
            let parent_path = match parent.path.as_deref() {
                Some(path) if !path.is_empty() => path,
                _ => parent.directory.as_str(),
            };
            if parent_path != workspace.workspace_path {
                return Ok(None);
            }
        }
    }
    Ok(None)
}
