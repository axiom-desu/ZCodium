//! Node 3.16.2「Bash 输出 tmp 隔离」的 Rust 对齐验收：tmp 优先、精确 errno 降级、
//! 准备期取消不 spawn/不泄漏、前后台与 TaskOutput/Read 共用同一条冻结路径。
#![cfg(unix)]

use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use zcode_cli_core_api::{Event, EventSink, ToolPort};

fn workspace(root: &Path) -> PathBuf {
    root.join("workspace")
}

fn artifacts(root: &Path) -> PathBuf {
    root.join("artifacts")
}

fn tools_with_temp(root: &Path, temp: Option<PathBuf>) -> Arc<zcode_cli_tools::WorkspaceTools> {
    Arc::new(
        zcode_cli_rust::workspace_tools(workspace(root), artifacts(root))
            .with_bash_temp_parent(temp),
    )
}

fn first_component(path: &Path) -> String {
    path.components()
        .next()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn string(data: &serde_json::Value, key: &str) -> String {
    data[key].as_str().unwrap_or_default().to_owned()
}

fn bash(command: &str) -> serde_json::Value {
    json!({"command": command})
}

/// tmp 根下所有 `.output` 文件；零字节文件说明准备期新建后没有被 spawn 使用。
fn output_files(temp: &Path) -> Vec<PathBuf> {
    let mut files = vec![];
    let Ok(roots) = std::fs::read_dir(temp) else {
        return files;
    };
    for root in roots.flatten() {
        let session_root = root.path();
        let Ok(entries) = std::fs::read_dir(&session_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "output")
            {
                files.push(path);
            }
        }
    }
    files
}

async fn setup(root: &Path) {
    tokio::fs::create_dir_all(workspace(root)).await.unwrap();
}

#[tokio::test]
async fn bash_output_prefers_the_injected_temp_root_and_read_reads_it_back() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    let temp = root.path().join("tmp");
    tokio::fs::create_dir_all(&temp).await.unwrap();
    let tools = tools_with_temp(root.path(), Some(temp.clone()));
    let cancel = CancellationToken::new();
    let first = tools
        .call("s", "Bash", &bash("printf temp-one"), &cancel)
        .await
        .unwrap();
    assert_eq!(string(&first.data, "status"), "completed");
    let path = string(&first.data, "persistedOutputPath");
    let relative = Path::new(&path).strip_prefix(&temp).unwrap();
    assert!(
        first_component(relative).starts_with("zcode-bash-"),
        "Bash 输出必须落在注入的 tmp 父目录下，实际 {path}"
    );
    // Read 入口读取同一条冻结路径。
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "temp-one");
    let read = tools
        .call("s", "Read", &json!({"file_path": path}), &cancel)
        .await
        .unwrap();
    assert_eq!(read.data["content"], "temp-one");

    let second = tools
        .call("s", "Bash", &bash("printf temp-two"), &cancel)
        .await
        .unwrap();
    let second_path = string(&second.data, "persistedOutputPath");
    assert_eq!(
        first_component(relative),
        first_component(Path::new(&second_path).strip_prefix(&temp).unwrap()),
        "每个进程生命周期只创建一个 zcode-bash 根目录"
    );
    assert_eq!(std::fs::read_dir(&temp).unwrap().count(), 1);
    assert!(
        !artifacts(root.path()).exists(),
        "tmp 可用时 Bash 输出不应落回 artifacts 数据根"
    );
}

#[tokio::test]
async fn unusable_temp_parent_falls_back_to_the_artifact_root() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    // 可移植的 ENOTDIR fixture：父路径是普通文件而不是目录；不依赖权限位，
    // 因为 root/管理员身份会绕过 chmod。
    let blocked = root.path().join("blocked-temp");
    tokio::fs::write(&blocked, "not a directory").await.unwrap();
    let tools = tools_with_temp(root.path(), Some(blocked));
    let cancel = CancellationToken::new();
    let result = tools
        .call("s", "Bash", &bash("printf fallback-output"), &cancel)
        .await
        .unwrap();
    assert_eq!(string(&result.data, "status"), "completed");
    let path = string(&result.data, "persistedOutputPath");
    let relative = Path::new(&path)
        .strip_prefix(artifacts(root.path()))
        .expect("降级输出必须回到原有 artifacts 路径");
    assert!(!relative.starts_with(".."));
    assert_eq!(
        tokio::fs::read_to_string(&path).await.unwrap(),
        "fallback-output"
    );
}

#[tokio::test]
async fn unexpected_temp_failure_reports_spawn_error_without_spawning() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    // ELOOP 不在降级集合内：准备失败必须显式失败，不能凭空写入 artifacts。
    let link = root.path().join("loop");
    std::os::unix::fs::symlink(link.file_name().unwrap(), &link).unwrap();
    let tools = tools_with_temp(root.path(), Some(link.clone()));
    let cancel = CancellationToken::new();
    let marker = root.path().join("spawned");
    let error = tools
        .call(
            "s",
            "Bash",
            &bash(&format!("printf spawned > {}", marker.display())),
            &cancel,
        )
        .await
        .err()
        .expect("未列入降级集合的准备错误必须报 spawn_error");
    assert!(
        format!("{error:#}").contains("Cannot create Bash temp directory"),
        "错误信息必须说明准备失败，实际 {error:#}"
    );
    assert!(!marker.exists(), "准备失败的 Bash 不能启动子进程");
    assert!(!artifacts(root.path()).exists());

    // 失败不缓存 tmp 根：同一 adapter 在 tmp 恢复后可以重新选择 tmp。
    tokio::fs::remove_file(&link).await.unwrap();
    tokio::fs::create_dir(&link).await.unwrap();
    let recovered = tools
        .call("s", "Bash", &bash("printf recovered"), &cancel)
        .await
        .unwrap();
    let path = string(&recovered.data, "persistedOutputPath");
    assert!(
        Path::new(&path).starts_with(&link),
        "恢复后应重新使用 tmp：{path}"
    );
}

#[tokio::test]
async fn cancellation_before_spawn_leaves_no_prepared_output_file() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    let temp = root.path().join("tmp");
    tokio::fs::create_dir_all(&temp).await.unwrap();
    let tools = tools_with_temp(root.path(), Some(temp.clone()));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let marker = root.path().join("cancelled");
    // Node `createStoppedResult(..., "cancelled", "Execution cancelled before spawn")`：
    // 准备期取消是 cancelled 结果，不是 tool 错误（同一分类贯穿前台/后台）。
    let output = tools
        .call(
            "s",
            "Bash",
            &bash(&format!("printf spawned > {}", marker.display())),
            &cancel,
        )
        .await
        .expect("准备期取消必须返回 cancelled 结果，而不是 ToolError");
    assert_eq!(string(&output.data, "status"), "cancelled");
    assert_eq!(output.data["cancelled"], true);
    assert!(
        output.data.get("exitCode").is_none(),
        "未 spawn 的 Bash 不能带退出码"
    );
    assert!(
        string(&output.data, "stderr").contains("Execution cancelled before spawn"),
        "取消原因必须说明未 spawn，实际 {}",
        string(&output.data, "stderr")
    );
    assert!(!marker.exists(), "取消后的 Bash 不能启动子进程");
    assert!(output_files(&temp).is_empty(), "取消不应留下任何输出文件");
}

#[tokio::test]
async fn cancellation_during_preparation_keeps_no_unused_output_file() {
    for _ in 0..5 {
        let root = tempfile::tempdir().unwrap();
        setup(root.path()).await;
        let temp = root.path().join("tmp");
        tokio::fs::create_dir_all(&temp).await.unwrap();
        let tools = tools_with_temp(root.path(), Some(temp.clone()));
        let cancel = CancellationToken::new();
        let marker = root.path().join("raced");
        let task = {
            let tools = tools.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tools
                    .call(
                        "s",
                        "Bash",
                        &bash(&format!("printf raced > {}", marker.display())),
                        &cancel,
                    )
                    .await
            })
        };
        // 让 run 进入准备阶段（目录创建/打开句柄）后再取消，覆盖「已准备未 spawn」的竞态。
        tokio::task::yield_now().await;
        cancel.cancel();
        // 取消落在准备阶段也只能是 cancelled 结果：不能因竞态换一种分类。
        let output = task
            .await
            .unwrap()
            .expect("准备期取消必须返回 cancelled 结果，而不是 ToolError");
        assert_eq!(string(&output.data, "status"), "cancelled");
        assert_eq!(output.data["cancelled"], true);
        for file in output_files(&temp) {
            let size = std::fs::metadata(&file).unwrap().len();
            assert!(size > 0, "准备期取消留下了未使用的空输出文件：{file:?}");
        }
    }
}

fn sink(
    session: &str,
) -> (
    EventSink,
    tokio::sync::mpsc::Receiver<zcode_cli_core_api::RunEvent>,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    let sink = EventSink {
        session_id: session.into(),
        run_id: "run".into(),
        tx,
        origin: Default::default(),
        request_auth: None,
    };
    (sink, rx)
}

/// 后台登记需要 owner 提交；测试里直接接受，和真实会话一致。
async fn acknowledge(
    rx: &mut tokio::sync::mpsc::Receiver<zcode_cli_core_api::RunEvent>,
) -> tokio::sync::oneshot::Sender<()> {
    match rx.recv().await.unwrap().event {
        Event::Background { committed, .. } => committed.expect("registration commit"),
        _ => panic!("expected background registration"),
    }
}

#[tokio::test]
async fn background_task_output_reads_the_same_prepared_path() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    let temp = root.path().join("tmp");
    tokio::fs::create_dir_all(&temp).await.unwrap();
    let tools = tools_with_temp(root.path(), Some(temp.clone()));
    let cancel = CancellationToken::new();
    let (sink, mut rx) = sink("s");
    let task = {
        let tools = tools.clone();
        let cancel = cancel.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            tools
                .execute_scoped(
                    "Bash",
                    &json!({"command":"printf background-output","run_in_background":true}),
                    &sink,
                    &cancel,
                )
                .await
        })
    };
    let commit = acknowledge(&mut rx).await;
    commit.send(()).unwrap();
    let started = task.await.unwrap().unwrap();
    let path = string(&started.data, "persistedOutputPath");
    assert!(
        Path::new(&path).starts_with(&temp),
        "后台 Bash 必须使用同一条 tmp 路径：{path}"
    );
    let task_id = string(&started.data, "backgroundTaskId");
    let output = tools
        .call(
            "s",
            "TaskOutput",
            &json!({"task_id": task_id, "timeout": 10_000}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(output.data["task"]["outputFile"], json!(path));
    assert!(
        string(&output.data["task"], "output").contains("background-output"),
        "TaskOutput 必须从同一条路径读回输出"
    );
    tools.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeout_handoff_keeps_one_prepared_path_for_task_output() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path()).await;
    let temp = root.path().join("tmp");
    tokio::fs::create_dir_all(&temp).await.unwrap();
    let tools = tools_with_temp(root.path(), Some(temp.clone()));
    let cancel = CancellationToken::new();
    let (sink, mut rx) = sink("s");
    let task = {
        let tools = tools.clone();
        let cancel = cancel.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            tools
                .execute_scoped(
                    "Bash",
                    &json!({"command":"printf head; sleep 1; printf tail","timeout":200}),
                    &sink,
                    &cancel,
                )
                .await
        })
    };
    let commit = acknowledge(&mut rx).await;
    commit.send(()).unwrap();
    let started = task.await.unwrap().unwrap();
    assert_eq!(string(&started.data, "status"), "backgrounded");
    let path = string(&started.data, "persistedOutputPath");
    assert!(
        Path::new(&path).starts_with(&temp),
        "前台超时移交后台必须沿用同一条 tmp 路径：{path}"
    );
    let task_id = string(&started.data, "backgroundTaskId");
    let output = tools
        .call(
            "s",
            "TaskOutput",
            &json!({"task_id": task_id, "timeout": 10_000}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(output.data["task"]["outputFile"], json!(path));
    let tail = string(&output.data["task"], "output");
    assert!(
        tail.contains("tail"),
        "TaskOutput 应读到移交后的完整输出：{tail}"
    );
    tools.shutdown().await.unwrap();
}
