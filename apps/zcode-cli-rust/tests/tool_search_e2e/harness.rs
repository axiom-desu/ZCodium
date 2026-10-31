//! Real engine over a real `NodeStore` and a real loopback HTTP model.
use anyhow::Result;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_rust::adapters::{SystemClock, config, context_source, provider};
use zcode_cli_rust::contract::*;
use zcode_cli_state::NodeStore;
use zcode_cli_tools::WorkspaceTools;

use super::fixture::Fixture;

pub struct Harness {
    pub input: mpsc::Sender<Input>,
    output: mpsc::Receiver<Vec<Value>>,
    running: tokio::task::JoinHandle<Result<()>>,
    pub db: PathBuf,
    pub workspace: String,
    pub root: PathBuf,
    pub fixture: Arc<Fixture>,
    pub frames: Arc<std::sync::Mutex<Vec<Value>>>,
    _dir: Option<Arc<tempfile::TempDir>>,
}

impl Harness {
    pub async fn start(fixture: Arc<Fixture>) -> Self {
        let dir = Arc::new(tempfile::tempdir().unwrap());
        let root = dir.path().to_path_buf();
        Self::start_root(fixture, root, Some(dir)).await
    }

    pub async fn start_root(
        fixture: Arc<Fixture>,
        root: PathBuf,
        dir: Option<Arc<tempfile::TempDir>>,
    ) -> Self {
        Self::start_with_hooks(fixture, root, dir, Value::Null).await
    }

    pub async fn start_with_hooks(
        fixture: Arc<Fixture>,
        root: PathBuf,
        dir: Option<Arc<tempfile::TempDir>>,
        hooks: Value,
    ) -> Self {
        let workspace_path = root.join("w");
        std::fs::create_dir_all(&workspace_path).unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        let db = root.join("cli/db/db.sqlite");
        let store = NodeStore::open(db.clone(), root.join("cli/artifacts"), root.join("cache"))
            .await
            .unwrap();
        let home = root.join("home");
        let env = Arc::new(zcode_cli_net::RuntimeEnv::from_vars(vec![(
            "ZCODE_APP_VERSION".into(),
            "2.0.0".into(),
        )]));
        let egress = Arc::new(
            zcode_cli_net::Egress::new(
                env,
                &zcode_cli_net::NetworkPolicy::default(),
                &home,
                "test",
            )
            .unwrap(),
        );
        let config = provider::HttpModel::new(model_config(fixture.addr), egress.clone());
        let tools = WorkspaceTools::new(
            workspace_path.clone(),
            root.join("cli/artifacts"),
            Arc::new(zcode_cli_host::WorkspaceConfig::new(
                workspace_path.clone(),
                home.clone(),
                vec![],
            )),
            egress,
        );
        let identity = ModelIdentity {
            provider_id: "fixture".into(),
            model_id: "fixture".into(),
            reasoning_level: "none".into(),
        };
        let ports = RuntimePorts {
            context: Arc::new(context_source::WorkspaceContext::new(
                workspace_path.clone(),
                home,
                false,
                vec![].into(),
            )),
            store: Arc::new(store),
            model: Some(Arc::new(config)),
            tools: Arc::new(tools),
            clock: Arc::new(SystemClock),
        };
        let workspace = workspace_path.to_string_lossy().into_owned();
        let engine = zcode_cli_rust::app::Engine::new(workspace.clone(), Some(identity), ports)
            .await
            .unwrap()
            .with_tool_search_override(None)
            .with_title_generation(false)
            .with_hooks(&hooks, "fixture-user-config.json");
        let (input, rx) = mpsc::channel(64);
        let (out, mut out_rx) = mpsc::channel(256);
        let (frames, output) = mpsc::channel(256);
        tokio::spawn(async move {
            while let Some(batch) = out_rx.recv().await {
                if frames.send(batch).await.is_err() {
                    break;
                }
            }
        });
        let running = tokio::spawn(zcode_cli_rust::serve_values(
            engine,
            rx,
            out,
            CancellationToken::new(),
        ));
        Self {
            input,
            output,
            running,
            db,
            workspace,
            root,
            fixture,
            frames: Arc::new(std::sync::Mutex::new(vec![])),
            _dir: dir,
        }
    }

    pub async fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        let request: zcode_cli_protocol::Request =
            serde_json::from_value(json!({"id": id, "method": method, "params": params})).unwrap();
        self.input.send(Input::Request(request)).await.unwrap();
        loop {
            let frames =
                tokio::time::timeout(std::time::Duration::from_secs(10), self.output.recv())
                    .await
                    .expect("reply in time")
                    .unwrap();
            self.frames.lock().unwrap().extend(frames.iter().cloned());
            if let Some(frame) = frames.into_iter().find(|frame| frame["id"] == id) {
                return frame;
            }
        }
    }

    pub async fn command(&mut self, id: u64, params: Value) -> Value {
        self.request(id, "v4/command", params).await
    }

    pub async fn create(&mut self, id: u64, mode: &str) -> String {
        self.create_mode(id, "yolo", mode).await
    }

    pub async fn create_mode(&mut self, id: u64, execution: &str, mode: &str) -> String {
        let workspace = self.workspace.clone();
        let reply = self
            .request(
                id,
                "session/create",
                json!({
                    "workspace": {"workspacePath": workspace, "workspaceKey": workspace},
                    "mode": execution,
                    "runtimeConfig": {"toolSearch": {"mode": mode}},
                }),
            )
            .await;
        reply["result"]["session"]["sessionId"]
            .as_str()
            .expect("session id")
            .to_owned()
    }

    pub async fn send(&mut self, id: u64, session: &str, text: &str) -> Value {
        self.request(
            id,
            "session/send",
            json!({"sessionId": session, "content": text}),
        )
        .await
    }

    pub async fn compact(&mut self, id: u64, session: &str) -> Value {
        self.request(
            id,
            "session/compact",
            json!({"sessionId": session, "instructions": "summarize"}),
        )
        .await
    }

    pub async fn stop(&mut self, id: u64, session: &str) {
        self.command(
            id,
            json!({"commandId": format!("stop-{id}"), "clientId": "test",
                "sessionId": session, "type": "stop", "issuedAt": 1, "payload": {}}),
        )
        .await;
    }

    /// Waits until the session persisted `turns` completed turn boundaries.
    /// Waits until the fixture observed at least `count` model requests.
    pub async fn wait_requests(&self, count: usize) {
        for _ in 0..500 {
            if self.fixture.requests() >= count {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!(
            "model requests not observed: {} < {count}",
            self.fixture.requests()
        );
    }

    pub async fn settled(&self, session: &str, turns: u32) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        for _ in 0..500 {
            let done: u32 = conn
                .query_row(
                    "select count(*) from message where session_id = ?
                     and json_extract(data, '$.anchor.boundaryMessageId') is not null",
                    [session],
                    |row| row.get(0),
                )
                .unwrap();
            if done == turns {
                return conn;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("turns not persisted");
    }

    pub async fn wait_summary(&self, session: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        for _ in 0..500 {
            let done: u32 = conn
                .query_row(
                    "select count(*) from message where session_id = ?
                     and json_extract(data, '$.summary.title') = 'Compact summary'",
                    [session],
                    |row| row.get(0),
                )
                .unwrap();
            if done > 0 {
                return conn;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("compact summary not persisted");
    }

    pub async fn close(mut self) -> (PathBuf, Option<Arc<tempfile::TempDir>>) {
        self.input.send(Input::Eof).await.unwrap();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), self.running).await;
        (self.root.clone(), self._dir.take())
    }

    pub fn bodies(&self) -> Vec<Value> {
        self.fixture.bodies()
    }
}

fn model_config(addr: std::net::SocketAddr) -> config::ModelConfig {
    let mut config: config::ModelConfig = serde_json::from_value(json!({
        "providerId": "fixture",
        "modelId": "fixture",
        "reasoningLevel": "none",
        "baseUrl": format!("http://{addr}"),
        "apiType": "anthropic-messages",
        "formatProperties": {
            "inputFormat": {"supportsText": true},
            "outputFormat": {"supportsText": true},
            "supportsToolCall": true
        },
        "retry": {"maxRetries": 0, "baseDelayMs": 0, "jitter": false},
        "streamIdleTimeoutMs": 5000,
        "contextWindow": 200000,
        "maxOutputTokens": 4096,
        "contextBufferTokens": 1000
    }))
    .unwrap();
    config.access_type = Some("api-key".into());
    config
}
