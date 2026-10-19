use crate::{
    client::Client, editor::sanitize, interactions, picker, projection::View, session, terminal,
};
use anyhow::{Context, Result, bail};
use crossterm::{
    event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use ratatui::{Terminal, backend::CrosstermBackend};
use serde_json::{Value, json};
use std::io::IsTerminal;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_core_api::{ClientMsg, Method, ServerMsg};

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

async fn enter(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    if matches!(text.trim(), "/quit" | "/exit") {
        if view.busy() {
            session::stop(client, view).await?;
        }
        return Ok(true);
    }
    if let Some(interaction) = view.interaction().cloned() {
        let answer = interactions::answer(&interaction, text)?;
        let params = session::command(
            &view.session,
            "resolveInteraction",
            json!({"interactionId":interaction["interactionId"],"answer":answer}),
        );
        session::accepted(client.call(view, Method::Command, params).await?)?;
        // Pending interaction removal comes only from the actor's committed state patch.
    } else if view.busy() {
        bail!(
            "{}",
            view.text(
                "Turn is busy; draft was not submitted.",
                "运行中；草稿尚未提交。"
            )
        );
    } else if matches!(text.trim(), "/model" | "/mode" | "/sessions") {
        picker::open(client, view, request, text).await?;
    } else if text.starts_with('/') {
        return session::slash(client, view, request, text).await;
    } else if !text.trim().is_empty() {
        session::submit(client, view, request, text).await?;
    }
    Ok(false)
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
    session::open(&mut client, &mut view, &request, request.resume.clone()).await?;
    let mut cache = terminal::RenderCache::default();
    let mut dirty = true;
    let mut sidebar_leader = false;
    // 扫光只需要 UI 时钟：欢迎页可见时按 80ms 一帧推进，正文出现后立即停止重绘。
    let started = std::time::Instant::now();
    let mut frame_ms = 0u64;
    let mut frame_bucket = u64::MAX;
    let mut redraw = tokio::time::interval(std::time::Duration::from_millis(50));
    loop {
        tokio::select! {
            _=cancel.cancelled()=>return Ok(130),
            _=redraw.tick()=>{
                // 欢迎页可见（无正文、无告警）时按 80ms 一帧推进扫光，正文出现后自然停止。
                if crate::presentation::is_welcome(&view) {
                    let elapsed = started.elapsed().as_millis() as u64;
                    if elapsed / SHIMMER_FRAME_MS != frame_bucket {
                        frame_bucket = elapsed / SHIMMER_FRAME_MS;
                        frame_ms = elapsed;
                        dirty = true;
                    }
                }
                if dirty { terminal.draw(|frame|terminal::draw(frame,&view,&mut cache,frame_ms))?; dirty=false; }
                continue;
            },
            event=events.next()=>match event {
                Some(Ok(Event::Key(key))) if key.kind==KeyEventKind::Press=>{
                    if key.code!=KeyCode::Char('b') && !(key.code==KeyCode::Char('x') && key.modifiers.contains(KeyModifiers::CONTROL)) { sidebar_leader=false; }
                    // 全局退出/取消不能被弹窗吞掉；选择器不拥有 runtime 生命周期。
                    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code,KeyCode::Char('c'|'d')) {
                        let was_busy=view.busy();
                        if was_busy && let Err(error)=session::stop(&mut client,&mut view).await {view.push(&error.to_string());}
                        if key.code==KeyCode::Char('d') || !was_busy { return Ok(0); }
                        view.selector=None;
                    } else if view.selector.is_some() {
                        match key.code {
                            KeyCode::Esc => {if let Some(s)=view.selector.take(){view.editor.insert(&s.draft);}},
                            KeyCode::Up => if let Some(s)=view.selector.as_mut(){s.move_by(-1)},
                            KeyCode::Down => if let Some(s)=view.selector.as_mut(){s.move_by(1)},
                            KeyCode::Enter => if let Err(error)=picker::confirm(&mut client,&mut view,&request).await {view.push(&error.to_string());},
                            _=>{}
                        }
                    } else { match (key.code,key.modifiers) {
                    (KeyCode::Char('x'),m) if m.contains(KeyModifiers::CONTROL)=>sidebar_leader=true,
                    (KeyCode::Char('b'),m) if sidebar_leader && m.is_empty()=>{
                        if terminal.size()?.width<=120 {view.sidebar_overlay = !view.sidebar_overlay;} else {view.sidebar = !view.sidebar;view.sidebar_overlay=false;}
                        sidebar_leader=false;
                    },
                    (KeyCode::Esc,_) if view.sidebar_overlay=>view.sidebar_overlay=false,
                    (KeyCode::Char('c'),m) if m.contains(KeyModifiers::CONTROL)=>{
                        if view.busy() { if let Err(error)=session::stop(&mut client,&mut view).await {view.push(&error.to_string());} }
                        else{return Ok(0);}
                    }
                    (KeyCode::Char('d'),m) if m.contains(KeyModifiers::CONTROL)=>{
                        if view.busy(){let _=session::stop(&mut client,&mut view).await;}
                        return Ok(0);
                    }
                    (KeyCode::Enter,m) if m.intersects(KeyModifiers::SHIFT|KeyModifiers::ALT)=>view.editor.insert("\n"),
                    (KeyCode::Enter,_)=>{
                        let text=view.editor.clear();
                        match enter(&mut client,&mut view,&request,&text).await {
                            Ok(true)=>return Ok(0), Ok(false)=>{},
                            Err(error)=>{view.push(&format!("Error: {error}"));view.editor.insert(&text);}
                        }
                        view.follow=true;
                    }
                    (KeyCode::Char(c),m) if !m.intersects(KeyModifiers::CONTROL|KeyModifiers::ALT)=>view.editor.insert(&c.to_string()),
                    (KeyCode::Backspace,_)=>view.editor.backspace(), (KeyCode::Delete,_)=>view.editor.delete(),
                    (KeyCode::Left,_)=>view.editor.left(), (KeyCode::Right,_)=>view.editor.right(),
                    (KeyCode::Home,_)=>view.editor.home(), (KeyCode::End,_)=>view.editor.end(),
                    (KeyCode::Up|KeyCode::PageUp,_)=>{view.follow=false;view.scroll=view.scroll.saturating_sub(5);},
                    (KeyCode::Down|KeyCode::PageDown,_)=>{view.follow=false;view.scroll=view.scroll.saturating_add(5);},
                    _=>{}
                }}},
                Some(Ok(Event::Paste(text)))=>view.editor.insert(&sanitize(&text)),
                Some(Ok(Event::Resize(_, _)))=>{}, Some(Err(error))=>return Err(error.into()),
                None=>return Ok(0), _=>{}
            },
            message=client.next()=>{ client.observe(&mut view,message?).await?; }
        }
        dirty = true;
        if view.resync {
            client.refresh(&mut view).await?;
        }
    }
}
