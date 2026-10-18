mod args;
mod prompt;
mod provider_config;
mod runtime;
mod storage_startup;
mod tui;
use anyhow::Result;
use args::{AppServerArgs, Cli, Command};
use clap::Parser;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zcode_cli_app_server::{self as app_server, Sink, stdio};
use zcode_cli_core_api::SessionStore;

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    // 子命令走 clap；其余与 Node 一样由顶层参数决定（-p 无头运行或 TUI）。
    if argv.first().map(String::as_str) != Some("app-server") {
        std::process::exit(prompt::main(&argv).await);
    }
    if let Err(error) = run().await {
        // stderr 断管也不能递归进入错误处理；stdout 永远只用于协议。
        use std::io::Write;
        let _ = writeln!(std::io::stderr().lock(), "zcode-cli-rust: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    match Cli::parse().command {
        Command::AppServer(args) => app_server(args).await,
    }
}

async fn app_server(args: AppServerArgs) -> Result<()> {
    let home = runtime::home();
    let log_options = zcode_cli_host::logging::LogOptions::from_env(&home);
    let log_dir = log_options.directory.clone();
    let _logs = zcode_cli_host::logging::init(log_options);
    zcode_cli_host::log_retention::schedule(log_dir);
    tracing::info!(
        target: "zcode::runtime",
        event = "runtime.started",
        version = env!("CARGO_PKG_VERSION"),
        surface = args.surface.as_str(),
        prepare_storage = args.prepare_storage,
        "App server starting"
    );
    let ctx = runtime::Context::prepare(args.cwd, args.data_dir).await?;
    // 会话存储只有 Node 的库（spec rust-m11-node-storage §2.1）。
    let path = ctx.node_database().await?.database;
    let cancel = CancellationToken::new();
    let signal_cancel = cancel.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            if let Ok(mut term) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal_cancel.cancel();
    });
    let input_closed = CancellationToken::new();
    let mut input = stdio::start(input_closed.clone());
    let (mut output, writer) = Sink::stdout(cancel.clone());
    // `--prepare-storage` 只做握手与单次开库/复用，不复用常规 runtime/serve 路径。
    if args.prepare_storage {
        let prepared = storage_startup::prepare_storage(&ctx, &path, &mut input, &mut output).await;
        drop(output);
        let _ = stdio::finish(writer).await;
        return prepared;
    }
    // 常规启动仍必须先取 owner 锁再开库；握手 reuse 不能绕过该 gate。
    let _owner =
        zcode_cli_state::lock_workspace(ctx.data_dir.clone(), ctx.workspace.clone()).await?;
    let attempt = zcode_cli_host::id();
    let database_id = format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
    let progress = |phase: &str, sequence: u64| json!({"method":"startup/storageState","params":{"schemaVersion":1,"attemptId":attempt,"sequence":sequence,"databaseId":database_id,"databaseKind":"session","phase":phase,"elapsedMs":0}});
    output.send_values(vec![progress("checking", 1)]).await?;
    let store: Arc<dyn SessionStore> = match ctx.node_store().await {
        Ok(store) => Arc::new(store),
        Err(error) => {
            let mut frame = progress("failed", 2);
            // Node `DatabaseStartupErrorCode`：迁移与打开失败按原因上报，其余为 sql_failed。
            frame["params"]["errorCode"] = error
                .downcast_ref::<zcode_cli_state::node::open::StartupError>()
                .map_or("sql_failed", |e| e.code)
                .into();
            output.send_values(vec![frame]).await?;
            drop(output);
            let _ = stdio::finish(writer).await;
            anyhow::bail!("Session storage failed");
        }
    };
    output.send_values(vec![progress("ready", 2)]).await?;
    // Node 的协议会话在首条输入后生成标题（`-p` 不生成）。
    let engine = ctx
        .engine(store, args.config.as_ref(), args.surface == "desktop")
        .await?
        .with_title_generation(true);
    // App Server 独占 stdout；返回时已排空 runtime 输出并释放 sink。
    let served = app_server::serve(move |rx, tx| engine.serve(rx, tx, cancel), input, output).await;
    // 失败路径同样先等写线程落盘：存储失败的错误响应必须送达 Host 后进程才能退出。
    stdio::finish(writer).await?;
    served
}
