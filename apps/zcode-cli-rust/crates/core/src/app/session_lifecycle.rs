// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 会话运行实例生命周期（上游 `session-lifecycle/controller.ts`，
//! `.agents/specs/upstream-3.18-rust-parity.md` B 节）。
//!
//! 只管理本进程内的运行实例：不创建/删除持久会话，也不替代停止生成接口。
//! 存在性预检是只读查询（内存或 `session_exists`），绝不隐式激活或创建；
//! 激活/释放复用既有的 `ensure_session`/`shut_down`，不新建第二份 residency。
use super::Engine;
use crate::contract::{Method, RuntimeError};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// 生命周期状态（与上游 `sessionLifecycleStateSchema` 同义）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum State {
    #[default]
    Unloaded,
    Starting,
    Ready,
    Stopping,
    Faulted,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unloaded => "unloaded",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Stopping => "stopping",
            Self::Faulted => "faulted",
        }
    }
}

/// 每个会话的轻量生命周期事实：代次、修订与最后一次失败。
#[derive(Clone, Debug, Default)]
pub(super) struct Record {
    pub state: State,
    pub generation: u64,
    pub revision: u64,
    pub last_error: Option<Value>,
}

/// 解析后的调用参数：只允许 `sessionId` 与 `workspace`。
struct Params<'a> {
    id: &'a str,
    workspace: Option<&'a Map<String, Value>>,
}

fn params(p: &Value) -> Result<Params<'_>> {
    let object = p
        .as_object()
        .filter(|o| o.keys().all(|k| k == "sessionId" || k == "workspace"))
        .ok_or_else(|| RuntimeError::invalid_params("Unsupported session lifecycle fields"))?;
    let id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| RuntimeError::invalid_params("sessionId: required"))?;
    let workspace = match object.get("workspace") {
        None | Some(Value::Null) => None,
        Some(Value::Object(workspace)) => {
            let path = workspace
                .get("workspacePath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty());
            ensure!(path.is_some(), "workspace.workspacePath: required");
            Some(workspace)
        }
        Some(_) => return Err(RuntimeError::invalid_params("workspace: invalid")),
    };
    Ok(Params { id, workspace })
}

impl Engine {
    pub(super) async fn session_lifecycle(&mut self, method: Method, p: &Value) -> Result<Value> {
        let p = params(p)?;
        match method {
            Method::SessionLifecycleGetState => {
                self.assert_session_exists(p.id).await?;
                Ok(self.lifecycle_snapshot(p.id))
            }
            Method::SessionLifecycleEnsureReady => {
                self.assert_session_exists(p.id).await?;
                self.validate_activation(p.id, p.workspace).await?;
                self.activate_session(p.id).await?;
                Ok(json!({"completed": true}))
            }
            Method::SessionLifecycleStop => {
                self.assert_session_exists(p.id).await?;
                self.stop_session(p.id, None).await?;
                Ok(json!({"completed": true}))
            }
            Method::SessionLifecycleRestart => {
                self.assert_session_exists(p.id).await?;
                self.validate_activation(p.id, p.workspace).await?;
                self.stop_session(p.id, Some("restart")).await?;
                self.activate_session(p.id).await?;
                Ok(json!({"completed": true}))
            }
            _ => Err(RuntimeError::MethodNotFound(method.as_str().into()).into()),
        }
    }

    /// 只读存在性：内存会话或持久行；不加载、不创建、不写库。
    async fn assert_session_exists(&self, id: &str) -> Result<()> {
        if self.sessions.contains_key(id) || self.store.session_exists(id).await? {
            return Ok(());
        }
        Err(RuntimeError::Coded {
            code: -32004,
            message: format!("Session not found: {id}"),
        }
        .into())
    }

    /// 只读预检：已激活实例逐字段比较；冷实例只比较持久身份，不物化 runtime。
    async fn validate_activation(
        &mut self,
        id: &str,
        workspace: Option<&Map<String, Value>>,
    ) -> Result<()> {
        let Some(workspace) = workspace else {
            // 旧协议调用者不带 workspace：由持久记录提供上下文。
            return Ok(());
        };
        let path = workspace
            .get("workspacePath")
            .and_then(Value::as_str)
            .unwrap_or("");
        let identity = workspace
            .get("workspaceIdentity")
            .and_then(Value::as_str)
            .unwrap_or("");
        let conflict = || -> anyhow::Error {
            RuntimeError::Fault {
                message: "Session activation workspace conflicts with the persisted session".into(),
                code: Some("project.session-lineage-invalid".into()),
            }
            .into()
        };
        if let Some(session) = self.sessions.get(id) {
            let active = session
                .workspace_path
                .clone()
                .unwrap_or_else(|| self.workspace_path.clone());
            if active != path || session.workspace != self.workspace {
                return Err(conflict());
            }
            return Ok(());
        }
        // 冷实例：只读持久身份，不激活。
        let stored = self.store.read_session(&self.workspace, id).await?;
        let stored = stored.context("Session unavailable")?;
        let stored_path = stored
            .workspace_path
            .clone()
            .unwrap_or_else(|| self.workspace_path.clone());
        let identity_mismatch = !identity.is_empty() && stored.workspace != identity;
        if stored_path != path || identity_mismatch {
            return Err(conflict());
        }
        Ok(())
    }

    fn lifecycle_record(&mut self, id: &str) -> &mut Record {
        self.lifecycle.entry(id.to_owned()).or_default()
    }

    fn lifecycle_snapshot(&mut self, id: &str) -> Value {
        let resident = self.sessions.contains_key(id);
        let record = self.lifecycle_record(id);
        if record.state == State::Unloaded && resident {
            record.state = State::Ready;
        }
        let state = match record.state {
            // 没有登记的冷实例按归属读：有运行实例即 ready，否则 unloaded。
            State::Ready | State::Starting | State::Stopping | State::Faulted => record.state,
            State::Unloaded if resident => State::Ready,
            State::Unloaded => State::Unloaded,
        };
        json!({
            "sessionId": id,
            "state": state.as_str(),
            "generation": record.generation,
            "revision": record.revision,
            "lastError": record.last_error.clone().unwrap_or(Value::Null),
        })
    }

    fn transition(&mut self, id: &str, state: State) {
        let snapshot = {
            let record = self.lifecycle_record(id);
            record.state = state;
            record.revision += 1;
            let last_error = record.last_error.clone().unwrap_or(Value::Null);
            json!({
                "sessionId": id,
                "state": state.as_str(),
                "generation": record.generation,
                "revision": record.revision,
                "lastError": last_error,
            })
        };
        // 状态变化经既有通知通道发布；客户端重连后按 getState 对账。
        self.outbox
            .push(crate::contract::ServerMsg::HostNotification {
                method: "session/lifecycle/changed",
                params: snapshot,
            });
    }

    /// 幂等激活：已 ready 不重复激活，也不涨代次。
    async fn activate_session(&mut self, id: &str) -> Result<()> {
        if self.sessions.contains_key(id) {
            if self.lifecycle_record(id).state != State::Ready {
                self.transition(id, State::Ready);
            }
            return Ok(());
        }
        self.lifecycle_record(id).generation += 1;
        self.transition(id, State::Starting);
        if let Err(error) = self.ensure_session(id).await {
            // 启动失败先清理再抛原错：不能留下半初始化实例，也不能让迟到回调复活它。
            let cleanup = self.release_runtime_session(id).await;
            let record = self.lifecycle_record(id);
            record.last_error = Some(json!({
                "operation": "ensureReady",
                "code": classify(&error),
                "message": error.to_string(),
            }));
            self.transition(id, State::Unloaded);
            if let Err(cleanup) = cleanup {
                self.lifecycle_record(id).last_error = Some(json!({
                    "operation": "stop",
                    "code": "resourceReleaseFailed",
                    "message": cleanup.to_string(),
                }));
                self.transition(id, State::Faulted);
                return Err(anyhow::Error::new(ReleaseFailure {
                    activation: error.to_string(),
                    release: cleanup.to_string(),
                }));
            }
            return Err(error);
        }
        self.transition(id, State::Ready);
        self.lifecycle_record(id).last_error = None;
        Ok(())
    }

    /// 幂等释放：已 unloaded 无副作用；释放失败进入隔离态（不在下次激活里复活）。
    async fn stop_session(&mut self, id: &str, operation: Option<&str>) -> Result<()> {
        if !self.sessions.contains_key(id)
            && matches!(
                self.lifecycle_record(id).state,
                State::Unloaded | State::Ready
            )
        {
            self.lifecycle_record(id).state = State::Unloaded;
            return Ok(());
        }
        self.transition(id, State::Stopping);
        if let Err(error) = self.release_runtime_session(id).await {
            let record = self.lifecycle_record(id);
            record.last_error = Some(json!({
                "operation": operation.unwrap_or("stop"),
                "code": classify(&error),
                "message": error.to_string(),
            }));
            self.transition(id, State::Faulted);
            return Err(error);
        }
        self.transition(id, State::Unloaded);
        Ok(())
    }
}

/// 启动与清理都失败：两个错误都要保留（上游 `AggregateError`）。
#[derive(Debug)]
struct ReleaseFailure {
    activation: String,
    release: String,
}

impl std::fmt::Display for ReleaseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Session initialization and cleanup failed: {}; {}",
            self.activation, self.release
        )
    }
}

impl std::error::Error for ReleaseFailure {}

/// 错误码：typed 生命周期错误保留上游名字，其它按业务错误分类。
fn classify(error: &anyhow::Error) -> String {
    if let Some(coded) = error.downcast_ref::<RuntimeError>() {
        return match coded {
            RuntimeError::Coded { code: -32004, .. } => "sessionNotFound".into(),
            RuntimeError::Fault {
                code: Some(code), ..
            } => code.clone(),
            _ => "operationFailed".into(),
        };
    }
    "operationFailed".into()
}

/// 生命周期登记表（Engine 字段 `lifecycle` 的唯一读者）。
pub(super) type Records = BTreeMap<String, Record>;
