use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(version, about = "ZCodium Rust CLI runtime")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Serve the App stdio protocol (NDJSON on stdout, diagnostics on stderr).
    AppServer(AppServerArgs),
}

#[derive(clap::Args, Debug)]
pub struct AppServerArgs {
    #[arg(long, required = true)]
    pub stdio: bool,
    #[arg(long)]
    pub cwd: Option<PathBuf>,
    #[arg(long)]
    pub data_dir: Option<PathBuf>,
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long, value_parser=["desktop","terminal"], default_value="terminal")]
    pub surface: String,
    #[arg(long)]
    pub prepare_storage: bool,
    /// ToolSearch 启动偏好（缺省 off；不写 session/用户配置）。
    /// 不传时允许 Desktop Host 的 `runtimeConfig.toolSearch.mode` 生效。
    #[arg(long, value_parser=["auto","native","local","off"])]
    pub toolsearch_mode: Option<String>,
}
