use crate::{prompt, runtime};
use std::{io::IsTerminal, path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_core_api::{ClientMsg, SessionStore};
use zcode_cli_headless::args::{PromptArgs, Resume};

pub async fn main(args: PromptArgs) -> i32 {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        eprintln!("zcode-cli-rust: interactive TUI requires a terminal on stdin and stdout");
        return 1;
    }
    let cwd = match prompt::working_directory(args.cwd.as_deref()).await {
        Ok(path) => path,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    match run(args, cwd).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("zcode-cli-rust: {error:#}");
            1
        }
    }
}

async fn run(args: PromptArgs, cwd: PathBuf) -> anyhow::Result<i32> {
    let home = runtime::home();
    let log_options = zcode_cli_host::logging::LogOptions::from_env(&home);
    let log_dir = log_options.directory.clone();
    let _logs = zcode_cli_host::logging::init(log_options);
    zcode_cli_host::log_retention::schedule(log_dir);
    let ctx =
        runtime::Context::prepare(Some(cwd), args.data_dir.as_ref().map(PathBuf::from)).await?;
    let _owner =
        zcode_cli_state::lock_workspace(ctx.data_dir.clone(), ctx.workspace.clone()).await?;
    let store: Arc<dyn SessionStore> = Arc::new(ctx.node_store().await?);
    let config = args.config.as_ref().map(PathBuf::from);
    let engine = ctx.standalone_engine(store, config.as_ref(), false).await?;
    let path = ctx.requested_cwd.to_string_lossy().into_owned();
    let mut workspace = serde_json::json!({"workspacePath": path, "workspaceKey": ctx.workspace});
    if ctx.workspace != path {
        workspace["workspaceIdentity"] = ctx.workspace.clone().into();
    }
    let request = zcode_cli_tui::Request {
        workspace,
        directory: path,
        mode_override: args.mode_explicit.then_some(args.mode),
        resume: match args.resume {
            Resume::New => zcode_cli_tui::Resume::New,
            Resume::Id(id) => zcode_cli_tui::Resume::Id(id),
            Resume::Latest => zcode_cli_tui::Resume::Latest,
        },
        disallowed_tools: args.disallowed_tools,
        attachments: prompt::attachments(&args.attach, &ctx.cwd).await,
        locale: args.locale,
    };
    let (to, input) = mpsc::channel(64);
    let (output, mut from) = mpsc::channel(64);
    let cancel = CancellationToken::new();
    let actor = tokio::spawn(engine.serve(input, output, cancel.clone()));
    let (result, signal_code) = {
        let tui = zcode_cli_tui::run(request, (&to, &mut from), cancel.clone());
        tokio::pin!(tui);
        tokio::select! {
            result = &mut tui => (result, None),
            code = wait_for_signal() => {
                cancel.cancel();
                // 外部信号取消 TUI/runtime，由 TUI future 收尾终端后再走统一 Eof 清理。
                (tui.await, Some(code))
            }
        }
    };
    // root 是唯一 Eof owner；正常 quit 也必须关掉 Engine input，否则 actor/owner lock 常驻。
    if result.is_err() || signal_code.is_some() {
        cancel.cancel();
    }
    let drain = tokio::spawn(async move { while from.recv().await.is_some() {} });
    let _ = to.send(ClientMsg::Eof).await;
    actor.await??;
    drain.await?;
    match signal_code {
        Some(code) => Ok(code),
        None => result,
    }
}

async fn wait_for_signal() -> i32 {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut int), Ok(mut term), Ok(mut hup)) = (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
        ) else {
            return std::future::pending().await;
        };
        match tokio::select! {
            _ = int.recv() => "SIGINT",
            _ = term.recv() => "SIGTERM",
            _ = hup.recv() => "SIGHUP",
        } {
            "SIGINT" => 130,
            "SIGTERM" => 143,
            _ => 129,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        130
    }
}
