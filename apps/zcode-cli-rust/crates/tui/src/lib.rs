//! Native terminal frontend. Runtime facts stay owned by the core actor.
mod client;
mod client_control;
mod client_observe;
mod client_operations;
mod client_reads;
#[cfg(test)]
mod client_session_tests;
mod command_dispatch;
#[cfg(test)]
mod command_tests;
mod commands;
mod completion;
mod draft_attachments;
mod editor;
mod file_mentions;
mod file_mentions_draw;
mod flow;
mod flow_boot;
#[cfg(test)]
mod flow_channel_tests;
mod flow_command;
mod flow_picker;
mod flow_queue;
mod flow_session_list;
mod flow_setting;
mod flow_snapshot;
#[cfg(test)]
mod flow_tests;
mod frontend;
#[cfg(test)]
mod frontend_attach_tests;
#[cfg(test)]
mod frontend_draft_recovery_tests;
mod frontend_history_apply;
#[cfg(test)]
mod frontend_history_tests;
mod frontend_operations;
#[cfg(test)]
mod frontend_test_support;
#[cfg(test)]
mod frontend_tests;
mod input_history;
#[cfg(test)]
mod input_history_recovery_tests;
#[cfg(test)]
mod input_history_tests;
mod interactions;
mod keyboard;
mod operations;
#[cfg(test)]
mod operations_dispatch_tests;
mod operations_restore;
#[cfg(test)]
mod operations_tests;
mod picker;
mod presentation;
mod presentation_markdown;
#[cfg(test)]
mod presentation_marker_spacing_tests;
mod presentation_markers;
mod presentation_panels;
#[cfg(test)]
mod presentation_parity_tests;
#[cfg(test)]
mod presentation_pending_tests;
mod presentation_status;
#[cfg(test)]
mod presentation_tests;
mod presentation_text;
mod presentation_welcome;
mod projection;
mod projection_snapshot;
#[cfg(test)]
mod projection_tests;
mod queue;
#[cfg(test)]
mod queue_contract_tests;
mod queue_edit;
#[cfg(test)]
mod queue_edit_tests;
#[cfg(test)]
mod queue_frontend_guard_tests;
mod queue_menu;
mod queue_render;
#[cfg(test)]
mod queue_render_tests;
mod queue_state;
#[cfg(test)]
mod queue_test_support;
#[cfg(test)]
mod queue_tests;
#[cfg(test)]
mod responsive_submit_tests;
mod selector;
mod session;
mod telemetry;
#[cfg(test)]
mod telemetry_apply_tests;
mod telemetry_render;
#[cfg(test)]
mod telemetry_render_tests;
#[cfg(test)]
mod telemetry_tests;
mod terminal;
mod transport;
#[cfg(test)]
mod transport_parity_tests;
#[cfg(test)]
mod transport_paste_tests;
mod workspace_paths;

pub use transport::{Request, Resume, run};
