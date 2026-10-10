// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! An engine over a real `NodeStore` with a scripted model: every turn is a
//! `Read` tool step with reasoning, then the answer.
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicUsize},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zcode_cli_protocol::Request;
use zcode_cli_rust::{app::Engine, contract::*};
use zcode_cli_state::NodeStore;

pub(super) use super::model::IMAGE;
use super::{
    model::{Clock, Model},
    tools::Tools,
};

pub struct Harness {
    input: mpsc::Sender<Input>,
    output: mpsc::Receiver<Vec<Value>>,
    pub requests: mpsc::UnboundedReceiver<Vec<Value>>,
    pub db: PathBuf,
    pub workspace: String,
    pub root: PathBuf,
    _dir: Option<Arc<tempfile::TempDir>>,
}

/// A runtime in a fresh root: `ZCODE_CLI_RUST_NODE_DUMP/<dump>` when set
/// (kept for `scripts/zcode-cli-rust-node-storage-check.mjs`), else a
/// temporary one.
pub async fn start(
    dump: Option<&str>,
    gate: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
) -> Harness {
    let target = std::env::var_os("ZCODE_CLI_RUST_NODE_DUMP").zip(dump);
    let (root, dir) = match target {
        Some((root, name)) => (PathBuf::from(root).join(name), None),
        None => {
            let dir = tempfile::tempdir().unwrap();
            (dir.path().to_path_buf(), Some(Arc::new(dir)))
        }
    };
    run(root, dir, 0, gate).await
}

/// Another runtime over the same database, as after a restart.
pub async fn restart(previous: &Harness) -> Harness {
    run(previous.root.clone(), previous._dir.clone(), 10_000, None).await
}

async fn run(
    root: PathBuf,
    dir: Option<Arc<tempfile::TempDir>>,
    offset: usize,
    gate: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
) -> Harness {
    let db = root.join("cli/db/db.sqlite");
    let workspace = root.join("w").to_string_lossy().into_owned();
    let store = NodeStore::open(db.clone(), root.join("cli/artifacts"), root.join("cache"))
        .await
        .unwrap();
    let (requests_tx, requests) = mpsc::unbounded_channel();
    let ports = RuntimePorts {
        context: Arc::new(zcode_cli_host::context_source::WorkspaceContext::new(
            root.clone(),
            root.join("home"),
            false,
            vec![].into(),
        )),
        store: Arc::new(store),
        model: Some(Arc::new(Model {
            calls: AtomicUsize::new(0),
            verifications: AtomicUsize::new(0),
            requests: requests_tx,
        })),
        tools: Arc::new(Tools {
            gate: Mutex::new(gate),
            root: root.clone(),
        }),
        clock: Arc::new(Clock(AtomicUsize::new(offset), std::time::Instant::now())),
    };
    let identity = ModelIdentity {
        provider_id: "p".into(),
        model_id: "m".into(),
        reasoning_level: "high".into(),
    };
    // 提问自动结束：20ms 后可见，60ms 后按空答案继续（Node 自动结束语义）。
    let engine = Engine::new(workspace.clone(), Some(identity), ports)
        .await
        .unwrap()
        .with_question_timing(20, 60);
    let (input, rx) = mpsc::channel(32);
    let (out, output) = mpsc::channel(256);
    tokio::spawn(zcode_cli_rust::serve_values(
        engine,
        rx,
        out,
        CancellationToken::new(),
    ));
    Harness {
        input,
        output,
        requests,
        db,
        workspace,
        root,
        _dir: dir,
    }
}

impl Harness {
    /// Sends one V4 command and returns its acknowledgement.
    pub async fn command(&mut self, id: u64, params: Value) -> Value {
        self.request(id, "v4/command", params).await
    }

    /// The live rows of `session` with the revision and log epoch they belong to.
    pub async fn rows(&mut self, id: u64, session: &str) -> (Vec<Value>, Value, Value) {
        let page = self
            .request(
                id,
                "v4/conversation/rowsRange",
                json!({"sessionId": session, "limit": 200}),
            )
            .await;
        let rows = page["rows"].as_array().cloned().expect("rows");
        (rows, page["atRevision"].clone(), page["atLogEpoch"].clone())
    }

    /// Sends one request and returns its result.
    pub async fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        let request: Request =
            serde_json::from_value(json!({"id": id, "method": method, "params": params})).unwrap();
        self.input.send(Input::Request(request)).await.unwrap();
        loop {
            let frames =
                tokio::time::timeout(std::time::Duration::from_secs(5), self.output.recv())
                    .await
                    .expect("response in time")
                    .unwrap();
            if let Some(frame) = frames.into_iter().find(|f| f["id"] == id) {
                return frame["result"].clone();
            }
        }
    }

    /// Starts a session with `text` as its first input.
    pub async fn create(&mut self, command: &str, text: &str) -> String {
        self.create_in("yolo", command, text).await
    }

    /// [`Harness::create`] in execution `mode`.
    pub async fn create_in(&mut self, mode: &str, command: &str, text: &str) -> String {
        let workspace = self.workspace.clone();
        let ack = self
            .command(
                1,
                json!({"commandId": command, "clientId": "cli", "sessionId": null,
                "type": "createSession", "issuedAt": 1, "payload": {"workspaceId": workspace,
                    "config": {"mode": mode}, "firstInput": {"text": text}}}),
            )
            .await;
        ack["result"]["sessionId"]
            .as_str()
            .expect("session id")
            .to_owned()
    }

    pub async fn send_text(&mut self, id: u64, session: &str, command: &str, text: &str) -> Value {
        self.command(
            id,
            json!({"commandId": command, "clientId": "cli", "sessionId": session,
                "type": "sendText", "issuedAt": 1, "payload": {"text": text}}),
        )
        .await
    }

    /// Waits until `turns` turns of the session completed with their boundary.
    pub async fn settled(&self, session: &str, turns: u32) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        for _ in 0..250 {
            let done: u32 = conn
                .query_row(
                    "select count(*) from message where session_id = ?
                     and json_extract(data, '$.anchor.boundaryMessageId') is not null",
                    [session],
                    |r| r.get(0),
                )
                .unwrap();
            if done == turns {
                return conn;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("turns not persisted");
    }
}

/// Writes what Rust reads back of `session` (history entries, rows and
/// state) next to the kept database, for Node's reading check.
pub fn dump(h: &Harness, conn: &rusqlite::Connection, session: &str) {
    dump_as(h, conn, session, "rust.json");
}

/// [`dump`] under another file name (several sessions of one database).
pub fn dump_as(h: &Harness, conn: &rusqlite::Connection, session: &str, file: &str) {
    if h._dir.is_some() {
        return;
    }
    let active = zcode_cli_state::node::cold::active(conn, session).unwrap();
    let artifacts = h.root.join("cli/artifacts");
    let read = |uri: &str| zcode_cli_state::node::artifacts::read(&artifacts, uri);
    let history: Vec<Value> = zcode_cli_rust::domain::node_history::hydrate(&active, &read)
        .entries
        .iter()
        .map(|e| e.to_node())
        .collect();
    let resumed = zcode_cli_state::node::resume::resume(conn, session, &read, None)
        .unwrap()
        .unwrap();
    let read = json!({"sessionId": session, "history": history,
        "rows": resumed.conversation.rows, "state": resumed.conversation.state});
    std::fs::write(h.root.join(file), read.to_string()).unwrap();
}
