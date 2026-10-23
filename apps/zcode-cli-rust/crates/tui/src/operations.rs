//! 非阻塞 operation 状态机（spec cli-rust-tui-responsive-operations §输入与草稿规则）。
//!
//! 唯一 owner：
//! - `Inflight` 独占“已发送但未结算”的 [`SentDraft`]；View 里不再保留可写 pending payload，
//!   因此等待 ACK 期间新输入的正文/附件天然不会被旧 ACK 清掉。
//! - `rejected` 只保留一份待恢复的拒绝草稿；有未处理拒绝草稿时禁止再发起 mutation。
//! - `stop` 意图合并一份：slot 被别的 mutation 占用时排队，slot 空后由调用方发出唯一 stop。
//!
//! 这里不发送任何请求，也不 await 回包；真实发送由 [`crate::client::Client`] 分配 token，
//! 非草稿 workflow（boot/setting/queue/picker/snapshot）由 [`crate::flow`] 的续步状态机持有。
use crate::draft_attachments::DraftAttachments;

/// 携带草稿的 UI mutation 类型；同一时刻只有一条在飞。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpKind {
    /// 普通正文/compact 的 sendText admission。
    Submit,
    /// 交互（审批/问答）答案。
    Interaction,
    /// Ctrl-C 的唯一 stop 意图。
    Stop,
}

impl OpKind {
    /// 结算失败时是否允许占用拒绝草稿槽（只读 stop 不产生草稿）。
    fn carries_draft(self) -> bool {
        matches!(self, Self::Submit | Self::Interaction)
    }
}

/// 一份已从 editor/draft 转移给 operation 的正文与附件（唯一副本）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SentDraft {
    pub text: String,
    pub attachments: DraftAttachments,
    /// 已发送但结果未知：标签跟随这份草稿，不跟随 alternate 槽位。
    pub unknown: bool,
}

impl SentDraft {
    pub(crate) fn new(text: impl Into<String>, attachments: DraftAttachments) -> Self {
        Self {
            text: text.into(),
            attachments,
            unknown: false,
        }
    }

    pub(crate) fn with_unknown(mut self) -> Self {
        self.unknown = true;
        self
    }
}

/// 一份明确可恢复的拒绝/未知归属草稿；来源 session 标签防止跨会话偷偷重发。
pub(crate) struct RejectedDraft {
    pub draft: SentDraft,
    pub session: String,
    pub generation: u64,
}

/// 一次 Ctrl-Y 交换的结果：alternate 是否被清空决定提交门禁是否解除。
pub(crate) struct Swapped {
    pub restored: SentDraft,
    /// 交换进 alternate 的当前草稿；`None` 表示空草稿把槽清空。
    pub kept: Option<SentDraft>,
    /// 恢复的是“已发送但结果未知”的旧 owner 草稿：发送前必须复核，不能当未接受重发。
    pub unknown_outcome: bool,
}

/// 发起 mutation 被本地拒绝的原因（提示文案由调用方按语言渲染）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BeginError {
    /// 已有 mutation 在飞：不重复 admission，也不在前端排队。
    Busy,
    /// 还有未处理的拒绝草稿：必须先恢复/编辑后再提交。
    RejectedPending,
}

struct Inflight {
    kind: OpKind,
    session: String,
    generation: u64,
    epoch: u64,
    draft: Option<SentDraft>,
}

/// 一次回包的归属校验结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Attribution {
    /// token/会话/世代/意图全部匹配，可以结算。
    Match,
    /// 迟到的旧 token、旧 generation 或已换 session：丢弃效果，不写新草稿。
    Stale,
}

#[derive(Default)]
pub(crate) struct Operations {
    inflight: Option<Inflight>,
    /// 确定被拒绝的草稿（actor 明确拒绝/传输失败）。
    pub(crate) rejected: Option<RejectedDraft>,
    /// 已发送但结果未知的旧 owner 草稿：只标记 pending，绝不擅自当未接受恢复。
    pub(crate) pending: Option<RejectedDraft>,
    /// 已显示“停止请求待处理”的意图（不伪造 cancelled/idle）。
    stop_pending: bool,
    /// slot 被别的 mutation 占用时排队的唯一 stop。
    stop_queued: bool,
    epoch: u64,
}

impl Operations {
    pub(crate) fn busy(&self) -> bool {
        self.inflight.is_some()
    }

    pub(crate) fn inflight_kind(&self) -> Option<OpKind> {
        self.inflight.as_ref().map(|i| i.kind)
    }

    /// 当前在飞 operation 的意图 epoch（`Client::dispatch_operation` 绑定票据用）。
    pub(crate) fn epoch(&self) -> u64 {
        self.inflight.as_ref().map_or(self.epoch, |i| i.epoch)
    }

    /// 还有未处理的恢复来源时禁止新 mutation：避免产生第二份拒绝草稿。
    pub(crate) fn has_rejected(&self) -> bool {
        self.rejected.is_some() || self.pending.is_some()
    }

    /// 唯一 alternate 槽当前是否真的持有可恢复数据（空草稿不算）。
    #[cfg(test)]
    pub(crate) fn alternate_len(&self) -> usize {
        self.rejected.iter().chain(self.pending.iter()).count()
    }

    /// 当前会话可恢复的 alternate 摘要：`(正文字符数, 是否结果未知)`。
    ///
    /// 只读，不 take：供 `/draft` 状态与提示使用，绝不因此丢失草稿。
    pub(crate) fn recoverable(&self, session: &str) -> Option<(usize, bool)> {
        self.rejected
            .iter()
            .chain(self.pending.iter())
            .find(|entry| entry.session == session)
            .map(|entry| (entry.draft.text.chars().count(), entry.draft.unknown))
    }

    /// 当前 alternate 是否是“已发送但结果未知”的草稿（必须由用户显式确认）。
    pub(crate) fn has_unknown(&self) -> bool {
        self.rejected
            .iter()
            .chain(self.pending.iter())
            .any(|entry| entry.draft.unknown)
    }

    pub(crate) fn stop_pending(&self) -> bool {
        self.stop_pending
    }

    /// 当前 in-flight 草稿的唯一只读视图（测试与恢复用，不提供可变副本）。
    #[cfg(test)]
    pub(crate) fn inflight_draft(&self) -> Option<&SentDraft> {
        self.inflight.as_ref().and_then(|i| i.draft.as_ref())
    }

    /// 测试专用：注入“恢复槽与 inflight 同时存在”的唯一不可能状态，验证不丢稿。
    #[cfg(test)]
    pub(crate) fn force_inflight_for_test(
        &mut self,
        kind: OpKind,
        session: &str,
        generation: u64,
        draft: SentDraft,
    ) {
        self.epoch = self.epoch.wrapping_add(1);
        self.inflight = Some(Inflight {
            kind,
            session: session.to_owned(),
            generation,
            epoch: self.epoch,
            draft: Some(draft),
        });
    }

    /// 发起一条 mutation：一次只允许一条在飞，且拒绝草稿未处理时不允许新 mutation。
    ///
    /// 返回值是该 operation 的意图 epoch；迟到的同 token 回包若 epoch 不同同样失效。
    pub(crate) fn begin(
        &mut self,
        kind: OpKind,
        session: &str,
        generation: u64,
        draft: Option<SentDraft>,
    ) -> Result<u64, BeginError> {
        if self.inflight.is_some() {
            return Err(BeginError::Busy);
        }
        // 未处理拒绝草稿只拦会带草稿的 mutation；stop/只读回拉仍要放行。
        if kind.carries_draft() && self.has_rejected() {
            return Err(BeginError::RejectedPending);
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.inflight = Some(Inflight {
            kind,
            session: session.to_owned(),
            generation,
            epoch: self.epoch,
            draft: if kind.carries_draft() { draft } else { None },
        });
        Ok(self.epoch)
    }

    /// 回包归属：token 之外的 session/generation/epoch 任一变化都使旧效果失效。
    fn attribute(
        &self,
        session: &str,
        generation: u64,
        kind: OpKind,
        epoch: Option<u64>,
    ) -> Attribution {
        match self.inflight.as_ref() {
            Some(inflight)
                if inflight.kind == kind
                    && inflight.session == session
                    && inflight.generation == generation
                    && epoch.is_none_or(|epoch| epoch == inflight.epoch) =>
            {
                Attribution::Match
            }
            _ => Attribution::Stale,
        }
    }

    /// 成功结算：只有 actor accepted 才结算这份已发送 draft，且绝不会碰当前 editor。
    pub(crate) fn accepted(
        &mut self,
        session: &str,
        generation: u64,
        kind: OpKind,
        epoch: Option<u64>,
    ) -> Attribution {
        let outcome = self.attribute(session, generation, kind, epoch);
        if outcome == Attribution::Match {
            self.inflight = None;
            if kind == OpKind::Stop {
                self.stop_pending = false;
            }
        }
        outcome
    }

    /// alternate 的第二恢复槽是否空闲：满槽时调用方必须显式保留/恢复，不能丢稿。
    pub(crate) fn pending_slot_free(&self) -> bool {
        self.pending.is_none()
    }

    /// 把无法立刻恢复的草稿放进结果未知槽（标签跟随草稿），返回是否放下。
    pub(crate) fn keep_pending(
        &mut self,
        session: &str,
        generation: u64,
        draft: SentDraft,
    ) -> bool {
        if self.pending.is_some() {
            return false;
        }
        self.pending = Some(RejectedDraft {
            draft: draft.with_unknown(),
            session: session.to_owned(),
            generation,
        });
        true
    }

    /// 拒绝/传输失败：保留一份可显式恢复的拒绝草稿；已有拒绝草稿时不再产生第二份。
    ///
    /// 返回本次是否真的生成了拒绝草稿槽（false 表示草稿仍由调用方 mock 的旧路径保留）。
    pub(crate) fn rejected(
        &mut self,
        session: &str,
        generation: u64,
        kind: OpKind,
        epoch: Option<u64>,
    ) -> (Attribution, bool) {
        let outcome = self.attribute(session, generation, kind, epoch);
        if outcome == Attribution::Stale {
            return (outcome, false);
        }
        // 先验证恢复槽容量再 take：槽已占用时保留原 inflight，由调用方显式拿回，
        // 绝不先 take 后返回 false 把草稿丢掉。一份拒绝草稿即上限。
        let carries_draft = self
            .inflight
            .as_ref()
            .is_some_and(|inflight| inflight.draft.is_some());
        if carries_draft && self.rejected.is_some() {
            return (outcome, false);
        }
        let Some(inflight) = self.inflight.take() else {
            return (Attribution::Stale, false);
        };
        if kind == OpKind::Stop {
            self.stop_pending = false;
        }
        let Some(draft) = inflight.draft else {
            return (outcome, false);
        };
        self.rejected = Some(RejectedDraft {
            draft,
            session: session.to_owned(),
            generation,
        });
        (outcome, true)
    }

    /// 发送前通道满/运行时拒绝：撤销在飞槽并交还草稿，调用方负责整份恢复。
    pub(crate) fn abort(&mut self) -> Option<SentDraft> {
        let inflight = self.inflight.take()?;
        if inflight.kind == OpKind::Stop {
            self.stop_pending = false;
        }
        inflight.draft
    }

    /// 切 session / TopicClosed：在飞 operation 的票据归属失效。
    ///
    /// 已发送但结果未知的草稿不能当未接受自动恢复、更不能跨会话重发：只标记为旧 owner
    /// pending，保留旧 session/generation 标签，等用户显式 Ctrl-Y。返回 `Some` 表示两个
    /// 恢复槽都已占用（极少数情况），调用方必须显式处理而不是静默丢稿。
    pub(crate) fn invalidate(&mut self, generation: u64) -> Option<SentDraft> {
        let stale = self
            .inflight
            .as_ref()
            .is_some_and(|inflight| inflight.generation != generation);
        if !stale {
            return None;
        }
        let inflight = self.inflight.take()?;
        self.stop_queued = false;
        self.stop_pending = false;
        let draft = inflight.draft?;
        let entry = RejectedDraft {
            draft: draft.with_unknown(),
            session: inflight.session,
            generation: inflight.generation,
        };
        if self.rejected.is_none() {
            self.rejected = Some(entry);
            return None;
        }
        if self.pending.is_none() {
            self.pending = Some(entry);
            return None;
        }
        Some(entry.draft)
    }

    /// Ctrl-C 的唯一 stop 意图：立刻可见；slot 被占用时排队等结算后发唯一 stop。
    ///
    /// `blocked` 表示别的 mutation workflow（boot/setting/queue/picker）仍占着全局门禁；
    /// 返回 `true` 表示调用方现在就能发送 stop；`false` 表示只记下唯一意图。
    pub(crate) fn request_stop(&mut self, blocked: bool) -> bool {
        if self.stop_pending || self.stop_queued {
            return false;
        }
        if blocked || self.inflight.is_some() {
            // 只有 submit/交互这类真实前台 workflow 才需要等它结算。
            self.stop_queued = true;
            self.stop_pending = true;
            return false;
        }
        self.stop_pending = true;
        true
    }

    /// 结算后检查是否有排队的 stop 需要发送；返回一次即清空排队标记。
    pub(crate) fn take_queued_stop(&mut self) -> bool {
        if self.inflight.is_some() {
            return false;
        }
        std::mem::take(&mut self.stop_queued)
    }

    /// 已发送 draft 的附件 refs：submit 组 payload 时只读这一份，避免 View 与 operation 双写。
    pub(crate) fn inflight_refs(&self, text: &str) -> Option<Vec<serde_json::Value>> {
        let draft = self.inflight.as_ref()?.draft.as_ref()?;
        Some(draft.attachments.refs_for_text(text))
    }
}
