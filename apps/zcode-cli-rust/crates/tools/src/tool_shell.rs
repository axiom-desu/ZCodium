use super::shell_background::{Launch, auto_eligible};
use super::tool_process::run;
use super::tools::{boolean, keys, string};
use crate::contract::{EventSink, ToolError, ToolOutput};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;
#[path = "task_tools.rs"]
mod task;

pub(super) struct Job {
    pub(super) cancel: CancellationToken,
    pub(super) state: watch::Receiver<Option<Value>>,
    pub(super) path: PathBuf,
    pub(super) command: String,
    pub(super) description: String,
}
pub struct ShellTasks {
    pub(super) jobs: Mutex<HashMap<String, HashMap<String, Arc<Job>>>>,
    /// Complete child environment (Node `buildExecutionEnv`).
    pub(super) env: Arc<[(String, String)]>,
    /// Bash 输出首选的 tmp 父目录（Node `bashOutputTempDir`）；`None` 只用 artifacts。
    bash_temp_parent: Option<PathBuf>,
    /// 进程生命周期内唯一的 `zcode-bash-*` 根目录；创建失败不缓存。
    bash_temp: super::bash_temp::TempRoot,
}
impl ShellTasks {
    pub fn new(env: Arc<[(String, String)]>, bash_temp_parent: Option<PathBuf>) -> Self {
        Self {
            jobs: Mutex::default(),
            env,
            bash_temp_parent,
            bash_temp: super::bash_temp::TempRoot::default(),
        }
    }
    pub async fn call(
        &self,
        paths: (&Path, &Path),
        session: &str,
        name: &str,
        args: &Value,
        sink: Option<&EventSink>,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput> {
        let (cwd, artifacts) = paths;
        match name {
            "Bash" => {
                self.start(cwd, artifacts, session, args, sink, cancel)
                    .await
            }
            "TaskOutput" | "TaskStop" => {
                keys(
                    args,
                    if name == "TaskOutput" {
                        &["task_id", "block", "timeout"]
                    } else {
                        &["task_id", "shell_id"]
                    },
                )?;
                let id = args["task_id"]
                    .as_str()
                    .or_else(|| args["shell_id"].as_str())
                    .filter(|id| !id.is_empty());
                let stop = name == "TaskStop";
                let Some(id) = id else {
                    if stop {
                        bail!("Missing required parameter: task_id");
                    }
                    return Err(ToolError::handler(1, "Task ID is required"));
                };
                let job = self
                    .jobs
                    .lock()
                    .await
                    .get(session)
                    .and_then(|jobs| jobs.get(id))
                    .cloned();
                let Some(job) = job else {
                    // Node：TaskOutput 在 validateInput 返回处理器失败，TaskStop 抛出错误。
                    let message = format!("No task found with ID: {id}");
                    if stop {
                        bail!("{message}");
                    }
                    return Err(ToolError::handler(2, message));
                };
                if stop {
                    return self.stop(id, &job, cancel).await;
                }
                self.task_output(id, &job, args, cancel).await
            }
            _ => bail!("Unsupported shell tool"),
        }
    }
    async fn start(
        &self,
        cwd: &Path,
        artifacts: &Path,
        session: &str,
        args: &Value,
        sink: Option<&EventSink>,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput> {
        keys(
            args,
            &[
                "command",
                "description",
                "timeout",
                "run_in_background",
                "dangerouslyDisableSandbox",
            ],
        )?;
        let command = string(args, "command")?.to_owned();
        if crate::domain::js_string::trim(&command).is_empty() {
            // Node：空命令返回空结果（由通用占位显示 "(Bash completed with no output)"）。
            return Ok(ToolOutput::text(String::new()));
        }
        let background = boolean(args, "run_in_background", false)?;
        boolean(args, "dangerouslyDisableSandbox", false)?;
        let description = args
            .get("description")
            .map(|_| string(args, "description"))
            .transpose()?
            .unwrap_or(&command)
            .to_owned();
        let timeout = match args.get("timeout") {
            None if background => None,
            value => {
                let n = match value {
                    None => 120000.0,
                    Some(v) => v
                        .as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
                        .context("Invalid Bash timeout")?,
                };
                if !n.is_finite() || n < 0.0 {
                    bail!("Invalid Bash timeout");
                }
                Some(Duration::from_millis(if n == 0.0 {
                    120000
                } else {
                    (n as u64).min(600000)
                }))
            }
        };
        let started = std::time::Instant::now();
        if cancel.is_cancelled() {
            // Node `createStoppedResult(..., "cancelled", "Execution cancelled before spawn")`：
            // spawn 之前已取消是 cancelled 结果，不是 ToolError；也不为它创建输出文件。
            return Ok(stopped(
                &command,
                "Execution cancelled before spawn",
                started,
            ));
        }
        let id = super::id();
        // 路径与句柄必须在 spawn 之前冻结：tmp 优先，只有精确 errno 才降级回 artifacts。
        let prepared = super::bash_temp::prepare(
            self.bash_temp_parent.as_deref(),
            artifacts,
            &id,
            &self.bash_temp,
        )
        .await?;
        if cancel.is_cancelled() {
            // 准备期取消：不 spawn，只删除本次新建的空文件；分类仍是同一 cancelled 结果。
            super::bash_temp::discard(prepared).await;
            return Ok(stopped(
                &command,
                "Execution cancelled before spawn",
                started,
            ));
        }
        let launch = Launch {
            id,
            path: prepared.path,
            combined: prepared.combined,
            command: command.clone(),
            description,
        };
        if !background {
            // Node：超时的前台命令转入后台（sleep 开头的命令除外），没有会话 owner 时照旧超时终止。
            if let (Some(sink), Some(deadline)) = (sink, timeout)
                && auto_eligible(&command)
            {
                let data = self
                    .auto((cwd, session), sink, launch, deadline, cancel)
                    .await?;
                return Ok(shell_output(&command, data, Some(started)));
            }
            let Launch { path, combined, .. } = launch;
            let data = run(cwd, &self.env, &command, &path, combined, timeout, cancel).await?;
            return Ok(shell_output(&command, data, Some(started)));
        }
        let sink = sink.context("Background execution requires a session owner")?;
        let data = self
            .explicit((cwd, session), sink, launch, timeout, cancel)
            .await?;
        Ok(shell_output(&command, data, None))
    }
    pub async fn cancel(&self, session: &str, id: Option<&str>) -> Result<()> {
        let all = self.jobs.lock().await;
        if let Some(id) = id {
            all.get(session)
                .and_then(|v| v.get(id))
                .context("Background task unavailable")?
                .cancel
                .cancel();
        } else if let Some(jobs) = all.get(session) {
            for job in jobs.values() {
                job.cancel.cancel();
            }
        }
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<()> {
        let jobs: Vec<_> = self
            .jobs
            .lock()
            .await
            .values()
            .flat_map(|jobs| jobs.values().cloned())
            .collect();
        for job in &jobs {
            job.cancel.cancel();
        }
        for job in jobs {
            let mut rx = job.state.clone();
            if rx.borrow().is_none() {
                let _ = rx.wait_for(|v| v.is_some()).await;
            }
        }
        Ok(())
    }
    pub async fn close_session(&self, session: &str) -> Result<()> {
        let jobs = self.jobs.lock().await.remove(session).unwrap_or_default();
        for job in jobs.values() {
            job.cancel.cancel();
        }
        for job in jobs.values() {
            let mut state = job.state.clone();
            if state.borrow().is_none() {
                state.wait_for(|result| result.is_some()).await?;
            }
        }
        Ok(())
    }
}
/// Node `createStoppedResult`：未 spawn 的取消/关闭是 cancelled 结果，字段与运行期取消
/// 的 shell data 同形，只是没有执行产物（无路径、无退出码）。
fn stopped(command: &str, message: &str, started: std::time::Instant) -> ToolOutput {
    let data = json!({"stdout":"","stderr":message,"status":"cancelled","interrupted":true,
        "timedOut":false,"cancelled":true,"stdoutTruncated":false,"stdoutBytes":0,
        "stderrBytes":0,"persistedOutputSize":0});
    shell_output(command, data, Some(started))
}
/// Node `formatBashModelContent`; `failed` is Node's provider `is_error`.
/// `started` is `None` for a background launch.
fn shell_output(command: &str, data: Value, started: Option<std::time::Instant>) -> ToolOutput {
    let (content, failed) = super::bash_output::bash_content(command, &data);
    // 前台转入后台的命令没有退出结果，Node 按 backgrounded 记。
    let run_ms = started
        .filter(|_| data.get("backgroundTaskId").is_none())
        .map(|at| at.elapsed().as_millis() as u64);
    let perf = super::bash_perf::detail(command, &data, run_ms);
    let mut output = ToolOutput::new(content, data);
    output.failed = failed;
    output.perf = Some(perf);
    output
}
