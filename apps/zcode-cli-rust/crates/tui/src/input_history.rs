//! 输入历史游标（spec cli-rust-tui-workbench §1「读端口与交互」）。
//!
//! 纯本地状态：这里不碰 Client、DB 或文件；键盘层把 [`Step`] 转成唯一 class 的只读票据，
//! 主循环验证 session/generation 后把回包交回 [`History::apply`]。历史正文与附件始终是
//! 未提交草稿，恢复不会自动提交或批准。
use crate::draft_attachments::{AttachmentSource, DraftAttachments};
use anyhow::Result;
use serde_json::Value;
use zcode_cli_core_api::RuntimeError;

/// 一次可写回编辑器的草稿：正文 + 与正文占位符一致的附件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Draft {
    pub(crate) text: String,
    pub(crate) attachments: DraftAttachments,
}

/// 一次 ↑/↓ 的处理结果；`Request` 才允许发一张历史票据。
#[derive(Debug)]
pub(crate) enum Step {
    /// 读取该 skip 的历史项（同一 class 最多一笔在飞）。
    Request(u32),
    /// 本地已有草稿可恢复（回到最新草稿），不需要读请求。
    Restore(Draft),
    /// 没有更早的输入；保留当前草稿与游标。
    AtStart,
    /// 历史后端不可用：显式提示，不当成空历史。
    Unavailable,
    /// 请求中再次按键/已在草稿位置：静默忽略，绝不多发一张票据。
    Ignore,
}

/// 历史回包应用结果。只有 `Restore` 会推进游标。
#[derive(Debug)]
pub(crate) enum Applied {
    Restore(Draft),
    /// 后端明确返回 `null`：没有更早项，游标与草稿都不动。
    End,
    /// 错误/不可恢复附件：显示提示并保留原草稿。
    Failed(String),
    /// 迟到、已编辑或不属于当前游标的回包：直接丢弃。
    Stale,
}

#[derive(Clone, Debug)]
struct Pending {
    skip: u32,
    revision: u64,
}

/// 会话内的历史游标。`offset == None` 表示当前是实时草稿。
#[derive(Default)]
pub(crate) struct History {
    session: String,
    generation: u64,
    offset: Option<u32>,
    saved: Option<Draft>,
    pending: Option<Pending>,
    /// 草稿正文 revision：任何真实编辑都让在飞结果失效。
    revision: u64,
    /// 已经确认没有更早项的最小 skip，避免重复请求同一个越界位置。
    exhausted: Option<u32>,
    /// 只记录不可恢复（record decode/attachment）的失败位置：下一次 ↑ 请求它之前的位置。
    /// 后端查询错误不写这里，不能靠盲跳掩盖网络/未实现错误。
    failed_skip: Option<u32>,
    unsupported: bool,
}

impl History {
    /// 切 session / TopicClosed / 同 id 新 generation：旧游标与在飞结果全部失效。
    pub(crate) fn reset(&mut self, session: &str, generation: u64) {
        if self.session == session && self.generation == generation {
            return;
        }
        *self = Self {
            session: session.to_owned(),
            generation,
            ..Self::default()
        };
    }

    /// 真实编辑：在飞回包不再有效；编辑历史项即脱离历史，编辑内容成为新草稿。
    ///
    /// 第一次 ↑ 时 `offset` 仍是 `None`，但 `saved` 已经保存了旧草稿；若只在
    /// `offset.is_some()` 时清理，编辑取消 pending 后再 ↑ 会把旧草稿当成首次草稿，
    /// ↓ 就会恢复错误正文。这里必须无条件清掉游标/首次草稿/越界标记。
    pub(crate) fn edited(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.pending = None;
        self.offset = None;
        self.saved = None;
        self.exhausted = None;
        self.failed_skip = None;
    }

    /// 后端明确不支持历史：后续 ↑ 只提示一次，不再反复发请求。
    pub(crate) fn mark_unsupported(&mut self) {
        self.unsupported = true;
    }

    /// 票据没发出去（运行时队列满/已关闭）：释放游标，下一次 ↑ 可以重试而不是永远停在 Ignore。
    pub(crate) fn request_failed(&mut self) {
        self.pending = None;
    }

    /// ↑：首次保存当前草稿与附件；请求中/到顶时保持现状。
    pub(crate) fn recall_up(
        &mut self,
        session: &str,
        generation: u64,
        text: &str,
        attachments: &DraftAttachments,
    ) -> Step {
        self.reset(session, generation);
        if self.unsupported {
            return Step::Unavailable;
        }
        if self.pending.is_some() {
            return Step::Ignore;
        }
        let base = self.offset.map_or(0, |offset| offset.saturating_add(1));
        // 上一项不可恢复时跳过它继续向上：游标本身不推进，原草稿仍保留。
        let target = self
            .failed_skip
            .map_or(base, |failed| base.max(failed.saturating_add(1)));
        if self.offset.is_none() && self.saved.is_none() {
            self.saved = Some(Draft {
                text: text.to_owned(),
                attachments: attachments.clone(),
            });
        }
        if self.exhausted == Some(target) {
            return Step::AtStart;
        }
        self.pending = Some(Pending {
            skip: target,
            revision: self.revision,
        });
        Step::Request(target)
    }

    /// ↓：回到较新项；`offset == 0` 时恢复首次保存的正文与附件，不发请求。
    ///
    /// `failed_skip < offset` 表示失败发生在 ↓ 方向：该新项不可恢复，必须继续向新跳
    /// （`failed_skip - 1`），否则会反复请求同一个 skip，永远回不到 saved 原草稿。
    /// `failed_skip == 0` 已是最新项，直接恢复原草稿并清空游标/越界/失败标记。
    /// `failed_skip >= offset` 是 ↑ 方向失败，按原正常 ↓ 请求更近项。
    pub(crate) fn recall_down(&mut self, session: &str, generation: u64) -> Step {
        self.reset(session, generation);
        if self.unsupported || self.pending.is_some() {
            return Step::Ignore;
        }
        let Some(offset) = self.offset else {
            // 仍在原草稿位置：保留 ↑ 方向的 failed_skip，等待下一次 ↑ 继续跳过坏项。
            return Step::Ignore;
        };
        if let Some(failed) = self.failed_skip.take()
            && failed < offset
        {
            if failed == 0 {
                return self.restore_saved();
            }
            let target = failed - 1;
            self.pending = Some(Pending {
                skip: target,
                revision: self.revision,
            });
            return Step::Request(target);
        }
        if offset == 0 {
            return self.restore_saved();
        }
        let target = offset.saturating_sub(1);
        self.pending = Some(Pending {
            skip: target,
            revision: self.revision,
        });
        Step::Request(target)
    }

    /// ↓ 回到首次草稿：恢复正文/附件并清空 pending、越界与失败标记。
    fn restore_saved(&mut self) -> Step {
        match self.saved.take() {
            Some(saved) => {
                self.offset = None;
                self.exhausted = None;
                self.pending = None;
                self.failed_skip = None;
                Step::Restore(saved)
            }
            None => Step::Ignore,
        }
    }

    /// 回包只在仍属于当前游标且草稿未被编辑时应用；附件恢复失败保留原草稿。
    pub(crate) fn apply(
        &mut self,
        session: &str,
        generation: u64,
        skip: u32,
        result: Result<Value, RuntimeError>,
        directory: &str,
    ) -> Applied {
        self.reset(session, generation);
        let Some(pending) = self
            .pending
            .as_ref()
            .filter(|pending| pending.skip == skip)
            .cloned()
        else {
            return Applied::Stale;
        };
        self.pending = None;
        if pending.revision != self.revision {
            return Applied::Stale;
        }
        let value = match result {
            Err(error) => return Applied::Failed(error.to_string()),
            Ok(value) => value,
        };
        if value.is_null() {
            self.exhausted = Some(skip);
            self.failed_skip = None;
            return Applied::End;
        }
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            self.failed_skip = Some(skip);
            return Applied::Failed("History entry has no text".into());
        };
        if text.trim().is_empty() {
            self.failed_skip = Some(skip);
            return Applied::Failed("History entry is empty".into());
        }
        let attachments = value.get("attachments").cloned().unwrap_or(Value::Null);
        // 启动 pinned 附件不是可随历史编辑静默丢的草稿：从首次保存的原草稿带入。
        let startup = self
            .saved
            .as_ref()
            .map(|saved| saved.attachments.clone())
            .unwrap_or_default();
        match restore(&attachments, directory, text, &startup) {
            Ok(attachments) => {
                self.offset = Some(skip);
                self.exhausted = None;
                self.failed_skip = None;
                Applied::Restore(Draft {
                    text: text.to_owned(),
                    attachments,
                })
            }
            Err(error) => {
                // 失败不推进 offset，但记住该位置让下一次 ↑ 能继续向上。
                self.failed_skip = Some(skip);
                Applied::Failed(format!("History attachments cannot be restored: {error}"))
            }
        }
    }
}

/// 从历史投影恢复草稿，并把原草稿里的启动 pinned 项按 `ref` 合并成一份 owner。
fn restore(
    attachments: &Value,
    directory: &str,
    text: &str,
    saved: &DraftAttachments,
) -> Result<DraftAttachments> {
    let mut restored = DraftAttachments::from_history(attachments, directory, text)?;
    for item in saved
        .items()
        .iter()
        .filter(|item| item.source == AttachmentSource::Startup)
    {
        restored.adopt(item)?;
    }
    Ok(restored)
}
