// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 永久删除的只读预检：owned tree、fork 谱系、附件引用、跨进程运行态与 revision。
use super::session_data::{ARTIFACT_PREFIX, owned_trees, parse_artifact_uris};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Linux `/proc/<pid>` 是唯一可靠的跨进程存活检查；其它平台保守视为存活
/// （宁可拒绝删除，也不能让崩溃进程的残留凭据被误判为可删）。
fn process_alive(pid: i64) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        true
    }
}

/// 引用可能藏在消息、回退、输入队列、历史附件或工作流 journal，不能只看 fork 谱系。
pub fn collect_references(conn: &Connection, inside: &BTreeSet<String>) -> Result<Vec<Value>> {
    let mut references: BTreeMap<String, Value> = BTreeMap::new();
    let mut queries: Vec<String> = [
        ("part", "session_id", "data"),
        ("message", "session_id", "data"),
        ("session_input", "session_id", "payload"),
        ("session_entry", "session_id", "data"),
        ("session", "id", "revert"),
        ("input_history", "session_id", "attachments"),
    ]
    .iter()
    .map(|(table, id, data)| {
        format!(
            "select t.{id} as session_id,t.{data} as body,s.title from {table} t join session s on s.id=t.{id} where s.time_deleted is null and instr(t.{data}, '{ARTIFACT_PREFIX}')>0"
        )
    })
    .collect();
    for (table, owner, columns) in [
        (
            "dwf_run",
            None,
            vec!["args_json", "result_json", "failure_json"],
        ),
        (
            "workflow_run",
            None,
            vec!["args_json", "stats_json", "failure_json"],
        ),
        (
            "dwf_node",
            Some("dwf_run"),
            vec!["input_json", "result_json", "error_json"],
        ),
        ("dwf_event", Some("dwf_run"), vec!["payload_json"]),
        ("dwf_actor", Some("dwf_run"), vec!["persona_json"]),
        (
            "workflow_activity",
            Some("workflow_run"),
            vec!["prompt", "opts_json", "result_json", "error_json"],
        ),
        ("workflow_event", Some("workflow_run"), vec!["payload_json"]),
    ] {
        let body = columns
            .iter()
            .map(|column| format!("coalesce(t.{column},'')"))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let from = match owner {
            Some(run) => format!("join {run} r on r.id=t.run_id"),
            None => String::new(),
        };
        let id = owner.map_or("t", |_| "r");
        queries.push(format!(
            "select s.id as session_id,{body} as body,s.title from {table} t {from} join session s on s.id={id}.parent_session_id where s.time_deleted is null and instr({body},'{ARTIFACT_PREFIX}')>0"
        ));
    }
    for query in queries {
        let mut statement = conn.prepare(&query)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (owner, body, title) = row?;
            if inside.contains(&owner) {
                continue;
            }
            let mut found: Vec<(String, String)> = Vec::new();
            parse_artifact_uris(&body, |session, artifact| {
                if inside.contains(session) {
                    found.push((session.to_owned(), artifact.to_owned()));
                }
            });
            for (session, artifact) in found {
                let key = format!("{session}/{artifact}");
                let entry = references.entry(key).or_insert_with(
                    || json!({"sessionId": session, "artifactId": artifact, "referrers": []}),
                );
                let referrers = entry["referrers"].as_array_mut().expect("referrers array");
                if !referrers.iter().any(|r| r["sessionId"] == owner.clone()) {
                    referrers.push(json!({"sessionId": owner, "title": title}));
                }
            }
        }
    }
    let mut values: Vec<Value> = references.into_values().collect();
    for value in &mut values {
        if let Some(referrers) = value["referrers"].as_array_mut() {
            referrers.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        }
    }
    values.sort_by(|a, b| {
        let key_a = format!(
            "{}/{}",
            a["sessionId"].as_str().unwrap_or(""),
            a["artifactId"].as_str().unwrap_or("")
        );
        let key_b = format!(
            "{}/{}",
            b["sessionId"].as_str().unwrap_or(""),
            b["artifactId"].as_str().unwrap_or("")
        );
        key_a.cmp(&key_b)
    });
    Ok(values)
}

pub fn inspect(conn: &Connection, root: &str, owner_id: &str) -> Result<Value> {
    let receipt: Vec<(String, String, String)> = {
        let mut statement = conn.prepare(
            "select session_id,retained_artifacts,state from session_purge where root_id=? order by session_id",
        )?;
        statement
            .query_map([root], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    let ids: Vec<String> = if receipt.is_empty() {
        owned_trees(conn, &[root.to_owned()])?
            .remove(root)
            .unwrap_or_default()
    } else {
        receipt.iter().map(|row| row.0.clone()).collect()
    };
    let inside: BTreeSet<String> = ids.iter().cloned().collect();
    let mut forks = Vec::new();
    {
        let mut statement = conn.prepare(
            "select id,title,parent_id from session where time_deleted is null order by id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (id, title, parent) = row?;
            if let Some(parent) = parent
                && inside.contains(&parent)
                && !inside.contains(&id)
            {
                forks.push(json!({"sessionId": id, "title": title}));
            }
        }
    }
    let mut references = collect_references(conn, &inside)?;
    for (session_id, retained, _) in &receipt {
        let artifacts: Vec<String> = serde_json::from_str(retained).unwrap_or_default();
        for artifact_id in artifacts {
            if !references.iter().any(|reference| {
                reference["sessionId"].as_str() == Some(session_id.as_str())
                    && reference["artifactId"].as_str() == Some(artifact_id.as_str())
            }) {
                references.push(json!({
                    "sessionId": session_id,
                    "artifactId": artifact_id,
                    "referrers": [],
                }));
            }
        }
    }
    references.sort_by(|a, b| {
        format!(
            "{}/{}",
            a["sessionId"].as_str().unwrap_or(""),
            a["artifactId"].as_str().unwrap_or("")
        )
        .cmp(&format!(
            "{}/{}",
            b["sessionId"].as_str().unwrap_or(""),
            b["artifactId"].as_str().unwrap_or("")
        ))
    });
    let mut foreign_runtime = false;
    let mut local_runtime_ids = Vec::new();
    let presence: Vec<(String, String, i64)> = {
        let mut statement =
            conn.prepare("select session_id,owner_id,process_id from session_runtime_presence")?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (session_id, owner, pid) in presence {
        if !inside.contains(&session_id) {
            continue;
        }
        if owner == owner_id {
            local_runtime_ids.push(session_id);
        } else if process_alive(pid) {
            foreign_runtime = true;
        } else {
            conn.execute(
                "delete from session_runtime_presence where session_id=? and owner_id=?",
                params![session_id, owner],
            )?;
        }
    }
    let mut pending_work = false;
    if receipt.is_empty() {
        for id in &ids {
            let input: Option<i64> = conn
                .prepare_cached(
                    "select 1 from session_input where session_id=? and status='admitted' limit 1",
                )?
                .query_row([id], |row| row.get(0))
                .optional()?;
            let target: Option<i64> = conn
                .prepare_cached(
                    "select 1 from session_target where session_id=? and status='active' limit 1",
                )?
                .query_row([id], |row| row.get(0))
                .optional()?;
            pending_work = input.is_some() || target.is_some();
            if pending_work {
                break;
            }
        }
    }
    let mut facts = Vec::new();
    for id in &ids {
        let fact: Option<(String, i64, Option<i64>)> = conn
            .prepare_cached("select id,time_updated,time_deleted from session where id=?")?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?;
        facts.push(match fact {
            Some((id, updated, deleted)) => {
                json!({"id": id, "time_updated": updated, "time_deleted": deleted})
            }
            None => Value::Null,
        });
    }
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_string(&json!({
                "ids": ids,
                "facts": facts,
                "forks": forks,
                "references": references,
                "pendingWork": pending_work,
            }))?
            .as_bytes()
        )
    );
    let workspace: Option<(String, Option<String>)> = conn
        .prepare_cached("select directory,workspace_id from session where id=?")?
        .query_row([root], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .or_else(|| {
            conn.prepare_cached(
                "select workspace_path,workspace_identity from session_purge where session_id=?",
            )
            .ok()
            .and_then(|mut statement| {
                statement
                    .query_row([root], |row| Ok((row.get(0)?, row.get(1)?)))
                    .optional()
                    .ok()
                    .flatten()
            })
        });
    Ok(json!({
        "workspacePath": workspace.as_ref().map(|w| w.0.clone()),
        "workspaceIdentity": workspace.and_then(|w| w.1),
        "revision": revision,
        "sessionIds": ids,
        "forks": forks,
        "references": references,
        "foreignRuntime": foreign_runtime,
        "localRuntimeIds": local_runtime_ids,
        "pendingWork": pending_work,
        "deleting": receipt.iter().any(|row| row.2 == "deleting"),
        "completed": !receipt.is_empty() && receipt.iter().all(|row| row.2 == "deleted"),
    }))
}
