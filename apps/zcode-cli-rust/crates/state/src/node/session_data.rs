// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 会话数据彻底删除的持久事实（Node `0025_session_permanent_deletion` +
//! `repositories/sessions.ts` 的 `inspect/begin/completeSessionDeletion`）。
//! 删除凭据跨进程/跨重启；运行态登记是唯一活跃事实；正文删除必须经 `purge`。
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use std::collections::{BTreeMap, BTreeSet};

/// 只沿“附属会话”展开；fork 是用户可见的独立任务，不能随源会话删除。
const OWNED_CHILD_TASK_TYPES: [&str; 4] = [
    "selection_side_chat",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
];
pub(super) const ARTIFACT_PREFIX: &str = "zcode-artifact://";
const SQL_ID_CHUNK: usize = 400;

pub fn owned_trees(conn: &Connection, roots: &[String]) -> Result<BTreeMap<String, Vec<String>>> {
    let exists = "select 1 from session where id = ?";
    let child_sql = format!(
        "select id from session where parent_id = ? and task_type in ({})
         union select child_session_id as id from session_task_link where parent_session_id = ?",
        vec!["?"; OWNED_CHILD_TASK_TYPES.len()].join(",")
    );
    let mut children = conn.prepare(&child_sql)?;
    let mut trees = BTreeMap::new();
    for root in roots {
        let present = conn
            .prepare_cached(exists)?
            .query_row([root], |_| Ok(()))
            .optional()?
            .is_some();
        if !present {
            trees.insert(root.clone(), Vec::new());
            continue;
        }
        let mut seen: BTreeSet<String> = BTreeSet::from([root.clone()]);
        let mut queue = std::collections::VecDeque::from([root.clone()]);
        while let Some(current) = queue.pop_front() {
            let mut values = vec![rusqlite::types::Value::Text(current.clone())];
            values.extend(
                OWNED_CHILD_TASK_TYPES
                    .iter()
                    .map(|kind| rusqlite::types::Value::Text((*kind).into())),
            );
            values.push(rusqlite::types::Value::Text(current));
            let rows = children
                .query_map(rusqlite::params_from_iter(values), |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in rows {
                if seen.insert(id.clone()) {
                    queue.push_back(id);
                }
            }
        }
        trees.insert(root.clone(), seen.into_iter().collect());
    }
    Ok(trees)
}

/// JS `decodeURIComponent`；非法转义保持原文。
fn decode_uri(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

pub(super) fn parse_artifact_uris(body: &str, mut visit: impl FnMut(&str, &str)) {
    for part in body.split(ARTIFACT_PREFIX).skip(1) {
        let session_end = part
            .find(|c: char| c == '/' || c == '"' || c == '\\' || c.is_whitespace())
            .unwrap_or(part.len());
        let session = &part[..session_end];
        let rest = &part[session_end..];
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        let artifact_end = rest
            .find(|c: char| {
                c == '"' || c == '\\' || c.is_whitespace() || matches!(c, '/' | '?' | '#')
            })
            .unwrap_or(rest.len());
        visit(&decode_uri(session), &decode_uri(&rest[..artifact_end]));
    }
}

pub fn artifact_referrers(
    conn: &Connection,
    targets: &[String],
) -> Result<BTreeMap<String, Vec<String>>> {
    let targets: BTreeSet<&str> = targets.iter().map(String::as_str).collect();
    let mut referrers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    if targets.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut statement = conn.prepare(
        "select p.session_id, p.data from part p join session s on s.id = p.session_id
         where s.time_deleted is null and instr(p.data, ?) > 0",
    )?;
    let rows = statement.query_map([ARTIFACT_PREFIX], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (owner, data) = row?;
        parse_artifact_uris(&data, |target, _| {
            if target != owner && targets.contains(target) {
                referrers
                    .entry(target.to_owned())
                    .or_default()
                    .insert(owner.clone());
            }
        });
    }
    Ok(referrers
        .into_iter()
        .map(|(target, ids)| (target, ids.into_iter().collect()))
        .collect())
}

/// 只读预检由独立模块实现：写路径与查询共用同一份 owned tree/引用事实。
pub use super::session_data_inspect::inspect;

fn coded(code: &str) -> anyhow::Error {
    anyhow::anyhow!("session-data.{code}")
}

/// 准入：同一事务内复查预检事实；已有凭据时重复调用幂等。
pub fn begin(
    conn: &Connection,
    root: &str,
    owner_id: &str,
    revision: &str,
    operation_id: &str,
    retained: &[(String, String)],
) -> Result<()> {
    conn.execute_batch("begin immediate")?;
    let result = (|| -> Result<()> {
        let snapshot = inspect(conn, root, owner_id)?;
        let foreign = snapshot["foreignRuntime"].as_bool().unwrap_or(false);
        let pending = snapshot["pendingWork"].as_bool().unwrap_or(false);
        if foreign || pending {
            return Err(coded("running"));
        }
        let deleting = snapshot["deleting"].as_bool().unwrap_or(false);
        let completed = snapshot["completed"].as_bool().unwrap_or(false);
        if !deleting && !completed {
            let ids: Vec<&str> = snapshot["sessionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if snapshot["revision"].as_str() != Some(revision) || ids.is_empty() {
                return Err(coded("changed"));
            }
            let mut insert = conn.prepare(
                "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?,?,?,?,?,?,'deleting')",
            )?;
            let path = snapshot["workspacePath"].as_str().unwrap_or("");
            let identity = snapshot["workspaceIdentity"].as_str();
            for id in ids {
                let artifacts: Vec<&str> = retained
                    .iter()
                    .filter(|(session, _)| session == id)
                    .map(|(_, artifact)| artifact.as_str())
                    .collect();
                insert.execute(params![
                    id,
                    root,
                    operation_id,
                    serde_json::to_string(&artifacts)?,
                    path,
                    identity
                ])?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("commit")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("rollback");
            Err(error)
        }
    }
}

/// 文件清理完成后才删除正文；凭据独立于 session，重启与旧 create 不能复活同一 ID。
pub fn complete(conn: &Connection, root: &str) -> Result<()> {
    let ids: Vec<String> = {
        let mut statement = conn.prepare("select session_id from session_purge where root_id=?")?;
        statement
            .query_map([root], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    purge(conn, &ids)?;
    conn.execute(
        "update session_purge set state='deleted' where root_id=?",
        params![root],
    )?;
    Ok(())
}

/// 正文删除：显式清理没有级联外键的表，级联负责正文。
pub fn purge(conn: &Connection, session_ids: &[String]) -> Result<()> {
    let trees = owned_trees(conn, session_ids)?;
    let ids: Vec<String> = trees
        .into_values()
        .flatten()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    conn.execute_batch("pragma foreign_keys = on")?;
    conn.execute_batch("begin immediate")?;
    let result = (|| -> Result<()> {
        for chunk in ids.chunks(SQL_ID_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(",");
            let values = || chunk.iter().map(String::as_str);
            conn.prepare(&format!(
                "delete from input_history where session_id in ({marks})"
            ))?
            .execute(rusqlite::params_from_iter(values()))?;
            conn.prepare(&format!(
                "delete from dwf_run where parent_session_id in ({marks})"
            ))?
            .execute(rusqlite::params_from_iter(values()))?;
            conn.prepare(&format!(
                "delete from workflow_run where parent_session_id in ({marks})"
            ))?
            .execute(rusqlite::params_from_iter(values()))?;
            conn.prepare(&format!("delete from session where id in ({marks})"))?
                .execute(rusqlite::params_from_iter(values()))?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("commit")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("rollback");
            Err(error.context("session purge failed"))
        }
    }
}

pub fn register_presence(conn: &Connection, owner_id: &str, session_id: &str) -> Result<()> {
    conn.execute(
        "insert or ignore into session_runtime_presence(session_id,owner_id,process_id) values(?,?,?)",
        params![session_id, owner_id, std::process::id()],
    )?;
    Ok(())
}

pub fn unregister_presence(conn: &Connection, owner_id: &str, session_id: &str) -> Result<()> {
    conn.execute(
        "delete from session_runtime_presence where session_id=? and owner_id=?",
        params![session_id, owner_id],
    )?;
    Ok(())
}

pub fn clear_presence(conn: &Connection, owner_id: &str) -> Result<()> {
    conn.execute(
        "delete from session_runtime_presence where owner_id=?",
        params![owner_id],
    )?;
    Ok(())
}

pub fn runtime_owner_id() -> String {
    format!("{}:{}", std::process::id(), uuid::Uuid::new_v4())
}

/// 测试与宿主共用的存在性判断：owner 行是否仍登记为活跃。
pub fn presence_rows(conn: &Connection) -> Result<Vec<(String, String, i64)>> {
    let mut statement =
        conn.prepare("select session_id,owner_id,process_id from session_runtime_presence")?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
