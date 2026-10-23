//! `@file` 补全的非阻塞状态机与面板。
//!
//! 只依赖编辑器草稿与 workspace 目录查询：每次 `sync` 收敛当前 token，`poll` 只取已完成
//! 的结果，任何慢 IO 都不阻塞键盘。`accept` 只写编辑器/草稿附件，从不提交 prompt。
use crate::{
    draft_attachments::{AttachResult, DraftAttachments},
    editor::Editor,
    workspace_paths::{self, Entry},
};
use anyhow::Result;
use futures_util::FutureExt;
use std::ops::Range;

// 面板入口由本模块对外提供；实际渲染实现在 `file_mentions_draw`（保持 400 行预算）。
#[allow(unused_imports)] // 集成 worker 在 presentation 中调用 `file_mentions::draw`
pub(crate) use crate::file_mentions_draw::{draw, draw_with_color};

/// 面板一次可见的最大行数（spec：最多 8 可见）。
pub(crate) const MAX_VISIBLE: usize = 8;

/// 当前激活的 mention token（字节偏移，与 `Editor::cursor_offset` 同一坐标系）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Active {
    pub(crate) trigger: usize,
    pub(crate) end: usize,
    pub(crate) token: String,
}

impl Active {
    fn key(&self) -> String {
        format!("{}:{}:{}", self.trigger, self.end, self.token)
    }
}

/// 与 TS 同规则：光标前最后一个 `@`，其前必须是行首/空白，token 内无空白。
pub(crate) fn active_mention(text: &str, cursor: usize) -> Option<Active> {
    let offset = floor_boundary(text, cursor.min(text.len()));
    let before = &text[..offset];
    let trigger = before.rfind('@')?;
    if text[..trigger]
        .chars()
        .next_back()
        .is_some_and(|prev| !prev.is_whitespace())
    {
        return None;
    }
    let token = &before[trigger + 1..];
    if token.chars().any(char::is_whitespace) {
        return None;
    }
    Some(Active {
        trigger,
        end: offset,
        token: token.to_owned(),
    })
}

fn floor_boundary(text: &str, mut offset: usize) -> usize {
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

struct Inflight {
    key: String,
    generation: u64,
    handle: tokio::task::JoinHandle<Result<(Vec<Entry>, bool)>>,
}

/// 每个 controller 至多一个在飞查询；新 token/新 session 直接取消旧 task，旧结果无效。
#[derive(Default)]
pub(crate) struct FileMentions {
    generation: u64,
    directory: String,
    active: Option<Active>,
    dismissed: Option<String>,
    items: Vec<Entry>,
    selected: usize,
    loading: bool,
    truncated: bool,
    error: Option<String>,
    notice: Option<String>,
    inflight: Option<Inflight>,
}

impl FileMentions {
    /// 精确签名（集成方调用）：`sync(&mut self, editor, directory, generation, enabled)`。
    /// 非阻塞：只启动/取消独立查询 task，不等待 IO。
    pub(crate) fn sync(
        &mut self,
        editor: &Editor,
        directory: &str,
        generation: u64,
        enabled: bool,
    ) {
        if self.generation != generation || self.directory != directory {
            // 切 session / 换 workspace：旧候选、旧提示与在飞 task 全部失效。
            self.generation = generation;
            self.directory.clear();
            self.directory.push_str(directory);
            self.active = None;
            self.dismissed = None;
            self.reset();
        }
        let active = if enabled {
            active_mention(editor.text(), editor.cursor_offset())
        } else {
            None
        };
        let Some(active) = active else {
            self.active = None;
            self.reset();
            return;
        };
        let key = active.key();
        if self.dismissed.as_deref() == Some(key.as_str()) {
            self.active = None;
            self.reset();
            return;
        }
        let changed = self.active.as_ref() != Some(&active);
        self.active = Some(active.clone());
        if !changed {
            // 同一 token：保留候选/选中；已有在飞查询就不再发第二次。
            self.selected = self.selected.min(self.items.len().saturating_sub(1));
            return;
        }
        self.start(active);
    }

    fn start(&mut self, active: Active) {
        self.abort();
        self.items.clear();
        self.selected = 0;
        self.loading = true;
        self.truncated = false;
        self.error = None;
        let directory = self.directory.clone();
        let token = format!("@{}", active.token);
        let handle = tokio::spawn(async move {
            workspace_paths::query(&directory, &token, workspace_paths::DEFAULT_LIMIT).await
        });
        self.inflight = Some(Inflight {
            key: active.key(),
            generation: self.generation,
            handle,
        });
    }

    fn reset(&mut self) {
        self.abort();
        self.items.clear();
        self.selected = 0;
        self.loading = false;
        self.truncated = false;
    }

    fn abort(&mut self) {
        if let Some(inflight) = self.inflight.take() {
            inflight.handle.abort();
        }
    }

    /// 只处理已完成结果；query/cursor/generation 与当前不符时丢弃。返回是否有展示变化。
    pub(crate) fn poll(&mut self) -> bool {
        let current = self.active.as_ref().map(Active::key);
        let stale = self.inflight.as_ref().is_some_and(|inflight| {
            Some(inflight.key.as_str()) != current.as_deref()
                || inflight.generation != self.generation
        });
        if stale {
            // 过期结果不能覆盖新 token；取消而不是只丢 handle（丢弃不会停掉 task）。
            self.abort();
            return false;
        }
        if !self
            .inflight
            .as_ref()
            .is_some_and(|inflight| inflight.handle.is_finished())
        {
            return false;
        }
        let Some(inflight) = self.inflight.take() else {
            return false;
        };
        let Some(outcome) = inflight.handle.now_or_never() else {
            // 已完成的 handle 一定有结果；这里只防御，保持 loading 而不是伪造空成功。
            return false;
        };
        self.loading = false;
        self.selected = 0;
        self.items.clear();
        self.truncated = false;
        match outcome {
            Ok(Ok((items, truncated))) => {
                self.error = None;
                self.truncated = truncated;
                self.items = items;
            }
            Ok(Err(error)) => self.error = Some(error.to_string()),
            // JoinError（panic/取消）不能伪装成“无匹配”的空成功：显式显示错误。
            Err(join_error) => {
                self.error = Some(format!("Workspace path search failed: {join_error}"));
            }
        }
        true
    }

    pub(crate) fn visible(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn items(&self) -> &[Entry] {
        &self.items
    }

    #[cfg(test)]
    pub(crate) fn selected(&self) -> usize {
        self.selected
    }

    pub(crate) fn loading(&self) -> bool {
        self.loading
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn truncated(&self) -> bool {
        self.truncated
    }

    /// 最近一次 acceptance 的可见提示（附件上限/无匹配），由前端 `view.push`。
    pub(crate) fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub(crate) fn move_by(&mut self, delta: isize) {
        if self.items.is_empty() {
            return;
        }
        self.selected =
            (self.selected as isize + delta).rem_euclid(self.items.len() as isize) as usize;
    }

    /// Esc 只隐藏当前 token 的候选；草稿/token 变化后自动恢复。
    pub(crate) fn dismiss(&mut self) {
        if let Some(active) = self.active.take() {
            self.dismissed = Some(active.key());
        }
        self.reset();
    }

    /// 当前候选窗口 `(start..end, 窗口内选中下标)`，选中项始终可见。
    pub(crate) fn window(&self) -> (Range<usize>, usize) {
        if self.items.is_empty() {
            return (0..0, 0);
        }
        let selected = self.selected.min(self.items.len() - 1);
        let visible = MAX_VISIBLE.min(self.items.len());
        let max_start = self.items.len() - visible;
        let start = selected.saturating_sub(visible - 1).min(max_start);
        (start..start + visible, selected - start)
    }

    /// Tab/Enter：目录继续补 `@dir/`；文件写 `@path ` 并登记草稿附件，这一次不提交。
    /// 返回是否消费该键（未显示候选时返回 false，交给其他处理器）。
    ///
    /// 登记附件前必须用编辑器**当前**的 token/range 复核缓存：Tab 或继续输入后缓存可能
    /// 已经过期，按旧 cache 写回会既改错正文，又留下没有占位符的 ghost 附件。
    pub(crate) fn accept(
        &mut self,
        editor: &mut Editor,
        attachments: &mut DraftAttachments,
    ) -> Result<bool> {
        let Some(active) = self.active.clone() else {
            return Ok(false);
        };
        self.notice = None;
        let current = active_mention(editor.text(), editor.cursor_offset());
        let Some(current) = current.filter(|current| *current == active) else {
            // 缓存已过期：不写正文、不登记附件，下一次 sync 会按新 token 重新查询。
            self.active = None;
            self.reset();
            return Ok(false);
        };
        let Some(entry) = self.items.get(self.selected).cloned() else {
            self.notice = Some(
                if self.loading {
                    "Still searching workspace paths…"
                } else {
                    "No matching workspace path."
                }
                .into(),
            );
            return Ok(true);
        };
        let replacement = if entry.directory {
            format!("@{}", entry.path)
        } else {
            match attachments.attach_entry(&entry) {
                AttachResult::Full => {
                    self.notice = Some(
                        "Attachment limit reached (16); the file was not attached and the draft was kept."
                            .into(),
                    );
                    return Ok(true);
                }
                AttachResult::Rejected => {
                    self.notice = Some("This file cannot be attached.".into());
                    return Ok(true);
                }
                AttachResult::Duplicate | AttachResult::Added => format!("@{} ", entry.path),
            }
        };
        if !editor.replace_range(current.trigger, current.end, &replacement) {
            return Ok(false);
        }
        self.active = None;
        self.reset();
        Ok(true)
    }
}

impl Drop for FileMentions {
    fn drop(&mut self) {
        // 丢弃 JoinHandle 不会取消任务：退出时必须显式 abort，否则留下无归属的查询 task。
        self.abort();
    }
}

#[cfg(test)]
#[path = "file_mentions_state_tests.rs"]
mod file_mentions_state_tests;
#[cfg(test)]
#[path = "file_mentions_tests.rs"]
mod file_mentions_tests;
