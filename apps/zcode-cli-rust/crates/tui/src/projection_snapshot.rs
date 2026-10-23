//! 完整快照的应用入口：malformed reply 不得擦除当前 View。
//!
//! `forceSnapshot`/`ConversationReset` 的 normal wire 值本身就是完整快照；这里不根据
//! 缺失字段做协议 fallback，只拒绝没有 `sessionId`/`seq` 或同会话 seq 倒退的畸形回包。
use crate::projection::{MAX_ROWS, View, bound_row};
use serde_json::Value;

impl View {
    /// 应用一份完整快照；返回是否真正应用。
    ///
    /// - 同会话：seq 不得倒退，否则是迟到/畸形回包；
    /// - 换会话：sessionId 必须非空，并重置滚动与 pending；
    /// - 同会话：保留用户滚动位置与真实在飞 draft 的 pending overlay。
    pub fn snapshot(&mut self, snapshot: &Value) -> bool {
        self.apply_snapshot(snapshot, false)
    }

    /// owner `ConversationReset` 的完整快照：同会话的新 logEpoch 可能重排 seq，
    /// 不能把合法 reset 当成迟到回包拒绝；普通快照仍保留 seq 不倒退的 FIFO 防御。
    pub(crate) fn reset_snapshot(&mut self, snapshot: &Value) -> bool {
        self.apply_snapshot(snapshot, true)
    }

    fn apply_snapshot(&mut self, snapshot: &Value, owner_reset: bool) -> bool {
        let Some(session) = snapshot["sessionId"].as_str().filter(|s| !s.is_empty()) else {
            return false;
        };
        let Some(seq) = snapshot["seq"].as_u64() else {
            return false;
        };
        let same_session = self.session == session;
        if same_session && !owner_reset && seq < self.seq {
            return false;
        }
        self.display_revision = self.display_revision.wrapping_add(1);
        // 成功快照/打开就是新的 owner 事实，解除 TopicClosed 的本地提交门禁。
        self.topic_closed = false;
        if !same_session {
            self.selector = None;
            // 旧 queue edit 不在这里静默删除：它属于旧会话/世代，保留为失效缓冲由用户
            // Esc 取消，避免编辑文本无声消失或落到新会话主 editor。
            // 补全是会话内的本地展示状态；切会话必须失效，不把旧草稿候选带到新会话。
            self.completion = crate::completion::Completion::default();
            // 同 id 重新进入也是一次新的票据世代：generation 推进并清掉旧遥测，
            // 同会话的普通 snapshot 则保留已取到的真实 MCP/usage。
            self.generation = self.generation.wrapping_add(1);
            self.telemetry.reset();
            // 历史游标/在飞票据同样按 generation 失效；旧 reply 不能写进新会话草稿。
            self.history.reset(session, self.generation);
        }
        self.session = session.into();
        self.rows = snapshot["rows"]["window"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for row in &mut self.rows {
            bound_row(row);
        }
        if self.rows.len() > MAX_ROWS {
            self.rows.drain(..self.rows.len() - MAX_ROWS);
        }
        self.seq = seq;
        self.state = snapshot.clone();
        if let Some(state) = self.state.as_object_mut() {
            state.remove("rows");
        }
        self.resync = false;
        // pending 只跟随唯一在飞 operation 派生；同会话快照不能清未 ACK overlay。
        self.pending_submit = same_session && self.operations.busy();
        if !same_session {
            self.follow = true;
            self.scroll = 0;
        }
        true
    }
}
