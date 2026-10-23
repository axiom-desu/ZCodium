//! boot / 会话切换 workflow：list → resume|create → (setmode) → topicopen → 应用快照。
//!
//! 每一步只发一个请求并立即返回主循环；快照仍在 actor 侧生成，这里绝不 await 回包。
//! 第一帧因此在 boot 完成前就能显示并接受输入、quit 与 resize。
use crate::{
    flow::{Effects, Progress},
    projection::View,
    transport::{Request, Resume},
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

enum Stage {
    /// `Resume::Latest`：先列会话再决定 id。
    List,
    Resume,
    Create,
    SetMode,
    TopicOpen,
}

pub(crate) struct Boot {
    workspace: Value,
    /// create 用：沿用已恢复会话的档位，或显式 `--mode`，或默认 build。
    mode: String,
    mode_override: Option<String>,
    stage: Stage,
    id: String,
    resumed: bool,
    settings: Value,
}

impl Boot {
    /// 打开一条会话；`target` 与 `--mode` 语义完全沿用原 `session::open`。
    pub(crate) fn new(view: &View, request: &Request, target: Resume) -> Self {
        let mode = if view.state["config"].is_object() {
            view.mode().to_owned()
        } else {
            request
                .mode_override
                .clone()
                .unwrap_or_else(|| "build".into())
        };
        let (stage, id, resumed) = match target {
            Resume::New => (Stage::Create, String::new(), false),
            Resume::Id(id) => (Stage::Resume, id, true),
            Resume::Latest => (Stage::List, String::new(), true),
        };
        Self {
            workspace: request.workspace.clone(),
            mode,
            mode_override: request.mode_override.clone(),
            stage,
            id,
            resumed,
            settings: Value::Null,
        }
    }

    pub(crate) fn step(&self) -> (Method, Value) {
        self.request()
    }

    fn request(&self) -> (Method, Value) {
        let workspace = &self.workspace;
        match self.stage {
            Stage::List => (Method::SessionList, json!({"workspace": workspace})),
            Stage::Resume => (
                Method::SessionResume,
                json!({"sessionId":self.id,"workspace":workspace}),
            ),
            Stage::Create => (
                Method::SessionCreate,
                json!({"workspace":workspace,"mode":self.mode,"persistence":"immediate"}),
            ),
            Stage::SetMode => (
                Method::SessionSetMode,
                json!({"sessionId":self.id,"mode":self.mode_override}),
            ),
            Stage::TopicOpen => (
                Method::TopicOpen,
                json!({"topic":format!("conversation/{}", self.id),"forceSnapshot":true}),
            ),
        }
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        let value = match result {
            Ok(value) => value,
            Err(error) => return Progress::Finish(Effects::error(error)),
        };
        match self.stage {
            Stage::List => match latest(&value) {
                Some(id) => {
                    self.id = id;
                    self.stage = Stage::Resume;
                    Progress::Next
                }
                None => Progress::Finish(Effects::error("No resumable session found")),
            },
            Stage::Resume | Stage::Create => {
                let Some(id) = value["session"]["sessionId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| (!self.id.is_empty()).then(|| self.id.clone()))
                else {
                    return Progress::Finish(Effects::error("Missing session id"));
                };
                self.id = id;
                self.settings = value["settings"].clone();
                // session/resume 自带持久化档位；只有显式 --mode 才覆盖既有会话。
                self.stage = if self.resumed && self.mode_override.is_some() {
                    Stage::SetMode
                } else {
                    Stage::TopicOpen
                };
                Progress::Next
            }
            Stage::SetMode => {
                self.stage = Stage::TopicOpen;
                Progress::Next
            }
            Stage::TopicOpen => {
                let previous = std::mem::take(&mut view.session);
                view.snapshot(&value["snapshot"]);
                view.models = self.settings["model"]["available"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                view.notices.clear();
                // 恢复当前会话时不能释放同一个刚打开的 topic，否则下一轮流式事件会被取消订阅。
                let release = (!previous.is_empty() && previous != view.session)
                    .then(|| format!("conversation/{previous}"));
                Progress::Finish(Effects {
                    dirty: true,
                    error: None,
                    release,
                })
            }
        }
    }
}

/// 最新可恢复的顶层会话；缺失/空 id 都是明确的“没有”，不猜。
fn latest(listed: &Value) -> Option<String> {
    listed["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|session| session.get("parentSessionId").is_none_or(Value::is_null))
        .max_by_key(|session| session["updatedAt"].as_u64().unwrap_or(0))
        .and_then(|session| session["sessionId"].as_str())
        .map(str::to_owned)
}
