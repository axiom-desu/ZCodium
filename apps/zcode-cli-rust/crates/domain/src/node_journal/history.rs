//! The input-history journal hook (Node `recordInputHistory`; spec
//! cli-rust-tui-workbench §1). Only a prompt the actor accepted is recorded,
//! and only for a stored session: the caller pushes it right after the
//! admission row so the same transaction writes input, ACK and history.
use super::{InputHistory, Op};
use crate::session::Session;

impl Session {
    /// Queues the `input_history` row of an accepted root prompt.
    pub fn node_input_history(&mut self, now: u64, entry: InputHistory) {
        if self.node.created {
            self.node.push(now, Op::InputHistory(entry));
        }
    }
}
