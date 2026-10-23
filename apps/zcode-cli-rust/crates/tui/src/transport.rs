use crate::{client::Client, frontend, keyboard, projection::View, session, telemetry, terminal};
use anyhow::{Context, Result, bail};
use crossterm::{
    event::{Event, EventStream, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use ratatui::{Terminal, backend::CrosstermBackend};
use serde_json::Value;
use std::io::IsTerminal;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_core_api::{ClientMsg, ServerMsg};

#[allow(unused_imports)] // 集成测试与 `run` 共用这两个入口
pub(crate) use crate::frontend::{paste_into, submit_editor};

const SHIMMER_FRAME_MS: u64 = 80;

#[derive(Clone, Debug)]
pub enum Resume {
    New,
    Id(String),
    Latest,
}
pub struct Request {
    pub workspace: Value,
    pub directory: String,
    /// Explicit CLI override only; absent preserves a resumed session's stored mode.
    pub mode_override: Option<String>,
    pub resume: Resume,
    pub disallowed_tools: Vec<String>,
    pub attachments: Vec<Value>,
    pub locale: String,
}
struct TerminalGuard;
impl TerminalGuard {
    fn enter() -> Result<Self> {
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            bail!(
                "Interactive TUI requires stdin and stdout to be a TTY. Use -p for non-interactive input."
            );
        }
        enable_raw_mode().context("enable terminal raw mode")?;
        if let Err(error) = execute!(
            std::io::stdout(),
            EnterAlternateScreen,
            crossterm::event::EnableBracketedPaste
        ) {
            let _ = disable_raw_mode();
            let _ = execute!(
                std::io::stdout(),
                crossterm::event::DisableBracketedPaste,
                LeaveAlternateScreen
            );
            return Err(error.into());
        }
        Ok(Self)
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            std::io::stdout(),
            crossterm::event::DisableBracketedPaste,
            LeaveAlternateScreen,
            crossterm::cursor::Show
        );
        let _ = disable_raw_mode();
    }
}

pub async fn run(
    request: Request,
    (to, from): (
        &mpsc::Sender<ClientMsg>,
        &mut mpsc::Receiver<Vec<ServerMsg>>,
    ),
    cancel: CancellationToken,
) -> Result<i32> {
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(std::io::stdout()))?;
    let mut events = EventStream::new();
    let mut client = Client::new(to, from);
    let mut view = View {
        zh: request.locale == "zh-CN"
            || (request.locale == "auto"
                && std::env::var("LANG").is_ok_and(|v| v.starts_with("zh"))),
        follow: true,
        sidebar: true,
        no_color: std::env::var_os("NO_COLOR").is_some(),
        directory: request.directory.clone(),
        ..View::default()
    };
    let mut frontend = frontend::Frontend::default();
    // `--attach` 只投影一次成第一份草稿的 pinned 附件，接受后清理，不会每轮重复发送。
    frontend.start(&mut view, &request)?;
    // boot 只登记并立即尝试发第一步：首帧在 boot 完成前就可绘制、可输入、可 quit/resize。
    session::begin_open(&mut client, &mut view, &request, request.resume.clone())?;
    let mut cache = terminal::RenderCache::default();
    // 扫光只需要 UI 时钟：欢迎页可见时按 80ms 一帧推进，正文出现后立即停止重绘。
    let started = std::time::Instant::now();
    let mut frame_ms = 0u64;
    let mut frame_bucket = u64::MAX;
    let mut redraw = tokio::time::interval(std::time::Duration::from_millis(50));
    loop {
        let mut dirty = false;
        tokio::select! {
            _=cancel.cancelled()=>return Ok(130),
            _=redraw.tick()=>{
                if crate::presentation::is_welcome(&view) {
                    let elapsed = started.elapsed().as_millis() as u64;
                    if elapsed / SHIMMER_FRAME_MS != frame_bucket {
                        frame_bucket = elapsed / SHIMMER_FRAME_MS;
                        frame_ms = elapsed;
                        dirty = true;
                    }
                }
                // 只处理已到期的 MCP 刷新时机；dirty 由 telemetry 自己维护，不做每 tick 查询。
                telemetry::pump(&mut client, &mut view, &request);
            },
            event=events.next()=>match event {
                Some(Ok(Event::Key(key))) if key.kind==KeyEventKind::Press=>{
                    let narrow = terminal.size()?.width <= 120;
                    if keyboard::handle(&mut frontend, &mut client, &mut view, &request, key, narrow).await? {
                        // root 退出只取消共享 token；不新增第二 reader，也不等 stop ACK。
                        cancel.cancel();
                        return Ok(0);
                    }
                    dirty = true;
                },
                Some(Ok(Event::Paste(text))) => {
                    frontend::paste_into(&mut view, &text);
                    dirty = true;
                },
                Some(Ok(Event::Resize(_, _)))=>{dirty=true;}
                Some(Err(error))=>return Err(error.into()),
                None=>return Ok(0), _=>{}
            },
            message=client.next()=>{ client.observe(&mut view,message?).await?; dirty=true; }
        }
        // 有界处理已完成 IO/回包（含 finally refresh）：不会在这里等待新的远端读请求。
        dirty |= frontend.poll(&mut client, &mut view).await?;
        if frontend.take_quit() {
            cancel.cancel();
            return Ok(0);
        }
        frontend.after_change(&mut view);
        if dirty {
            terminal.draw(|frame| terminal::draw(frame, &view, &mut cache, frame_ms))?;
        }
    }
}
