// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Real-binary `--prepare-storage` contract (spec cli-rust-m8-rust-storage).
//!
//! 每个用例都在临时 HOME/DB/workspace 中启动真实 binary，只通过 ndjson 控制帧交互：
//! 合法/非法握手、`reuse:true` 不触及数据库、开库失败帧与退出码、EOF 快速失败。
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child as StdChild, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

/// 远小于握手 30s 预算；失败用例也必须快速报错而不是等产品超时。
const FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_TIMEOUT: Duration = Duration::from_secs(15);

struct Prepared {
    child: StdChild,
    stdin: Option<ChildStdin>,
    frames: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    db: PathBuf,
    _root: tempfile::TempDir,
}

impl Prepared {
    /// 隔离的临时 HOME/workspace/DB；`--cwd` 与 `ZCODE_SESSION_DB_PATH` 都不指向用户数据。
    fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let cwd = root.path().join("ws");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let db = root.path().join("db.sqlite");
        let mut command = Command::new(env!("CARGO_BIN_EXE_zcode-cli-rust"));
        command
            .args(["app-server", "--stdio", "--prepare-storage"])
            .arg("--cwd")
            .arg(&cwd)
            .env_clear()
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("ZCODE_SESSION_DB_PATH", &db)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let captured = Arc::new(Mutex::new(String::new()));
        let sink = captured.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut text = sink.lock().unwrap();
                text.push_str(&line);
                text.push('\n');
            }
        });
        Prepared {
            stdin: child.stdin.take(),
            child,
            frames,
            stderr: captured,
            db,
            _root: root,
        }
    }

    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    fn frame(&self) -> Value {
        let line = self.frames.recv_timeout(FRAME_TIMEOUT).unwrap_or_else(|_| {
            panic!(
                "no frame within {FRAME_TIMEOUT:?}; stderr:\n{}",
                self.stderr()
            )
        });
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("invalid frame {line:?}: {e}"))
    }

    fn expect(&self, method: &str) -> Value {
        let frame = self.frame();
        assert_eq!(frame["method"], method, "unexpected frame: {frame}");
        frame
    }

    /// 读取进程给出的真实路径并断言它就是本用例的隔离数据库。
    fn storage_path(&self) -> PathBuf {
        let frame = self.expect("startup/storagePath");
        let path = frame["params"]["path"]
            .as_str()
            .expect("storagePath params.path");
        assert_eq!(PathBuf::from(path), self.db);
        PathBuf::from(path)
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().expect("stdin already closed");
        writeln!(stdin, "{value}").unwrap();
        stdin.flush().unwrap();
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + EXIT_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "process did not exit within {EXIT_TIMEOUT:?}; stderr:\n{}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn assert_no_more_frames(&self) {
        assert!(
            self.frames
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "unexpected extra frame"
        );
    }
}

#[test]
fn default_handshake_migrates_then_announces_prepared() {
    let mut prepared = Prepared::start();
    let db = prepared.storage_path();
    assert!(
        !db.exists(),
        "storagePath must arrive before the database opens"
    );

    prepared.send(json!({ "method": "startup/storagePathReady" }));
    let checking = prepared.expect("startup/storageState");
    assert_eq!(checking["params"]["phase"], "checking");
    let ready = prepared.expect("startup/storageState");
    assert_eq!(ready["params"]["phase"], "ready");
    prepared.expect("startup/storagePrepared");

    let status = prepared.wait();
    assert!(
        status.success(),
        "exit={status:?} stderr:\n{}",
        prepared.stderr()
    );
    assert!(
        db.exists(),
        "a non-reuse handshake must create/migrate the database"
    );
    prepared.assert_no_more_frames();
}

#[test]
fn reuse_true_does_not_create_a_missing_database() {
    let mut prepared = Prepared::start();
    let db = prepared.storage_path();
    assert!(!db.exists());

    prepared.send(json!({ "method": "startup/storagePathReady", "reuse": true }));
    prepared.expect("startup/storagePrepared");

    let status = prepared.wait();
    assert!(
        status.success(),
        "exit={status:?} stderr:\n{}",
        prepared.stderr()
    );
    assert!(
        !db.exists(),
        "reuse:true must skip opening/creating the database"
    );
    prepared.assert_no_more_frames();
}

#[test]
fn reuse_true_leaves_a_deliberately_corrupt_database_untouched() {
    let mut prepared = Prepared::start();
    let db = prepared.storage_path();
    let corrupt = b"this is deliberately not a sqlite database".to_vec();
    std::fs::write(&db, &corrupt).unwrap();

    prepared.send(json!({ "method": "startup/storagePathReady", "reuse": true }));
    prepared.expect("startup/storagePrepared");

    let status = prepared.wait();
    assert!(
        status.success(),
        "exit={status:?} stderr:\n{}",
        prepared.stderr()
    );
    assert_eq!(std::fs::read(&db).unwrap(), corrupt);
    // reuse 路径不得产生任何 storageState 帧（开库/迁移一律跳过）。
    prepared.assert_no_more_frames();
}

#[test]
fn corrupt_database_without_reuse_reports_failed_frame_and_nonzero_exit() {
    let mut prepared = Prepared::start();
    let db = prepared.storage_path();
    std::fs::write(&db, b"not a database").unwrap();

    prepared.send(json!({ "method": "startup/storagePathReady", "reuse": false }));
    let checking = prepared.expect("startup/storageState");
    assert_eq!(checking["params"]["phase"], "checking");
    let failed = prepared.expect("startup/storageState");
    assert_eq!(failed["params"]["phase"], "failed");
    assert!(
        failed["params"]["errorCode"].is_string(),
        "failed frame must carry errorCode: {failed}"
    );

    let status = prepared.wait();
    assert!(!status.success(), "open failure must exit non-zero");
}

fn assert_invalid_handshake_creates_no_database(frame: Value) {
    let mut prepared = Prepared::start();
    let db = prepared.storage_path();
    assert!(!db.exists());

    prepared.send(frame);
    let failed = prepared.expect("startup/storageState");
    assert_eq!(failed["params"]["phase"], "failed", "frame: {failed}");
    assert!(
        failed["params"]["errorCode"].is_string(),
        "failed frame must carry errorCode: {failed}"
    );

    let status = prepared.wait();
    assert!(!status.success(), "invalid handshake must exit non-zero");
    assert!(
        !db.exists(),
        "invalid reuse must not be treated as false and open the database"
    );
}

#[test]
fn invalid_reuse_shapes_are_not_treated_as_false() {
    for invalid in [
        json!({ "method": "startup/storagePathReady", "reuse": "yes" }),
        json!({ "method": "startup/storagePathReady", "reuse": null }),
        json!({ "method": "startup/storagePathReady", "reuse": 1 }),
        json!({ "method": "startup/storagePathReady", "reuse": true, "extra": 1 }),
    ] {
        assert_invalid_handshake_creates_no_database(invalid);
    }
}

#[test]
fn stdin_eof_fails_fast_with_transport_closed() {
    let mut prepared = Prepared::start();
    prepared.storage_path();
    let started = Instant::now();
    prepared.close_stdin();

    let failed = prepared.expect("startup/storageState");
    assert_eq!(failed["params"]["phase"], "failed");
    assert_eq!(failed["params"]["errorCode"], "transport_closed");

    let status = prepared.wait();
    assert!(!status.success(), "EOF must exit non-zero");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "EOF must fail before the 30s handshake budget"
    );
}
