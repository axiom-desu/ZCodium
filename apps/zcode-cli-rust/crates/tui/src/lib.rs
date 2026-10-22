//! Native terminal frontend. Runtime facts stay owned by the core actor.
mod client;
#[cfg(test)]
mod client_session_tests;
mod command_dispatch;
#[cfg(test)]
mod command_tests;
mod commands;
mod completion;
mod editor;
mod interactions;
mod picker;
mod presentation;
mod presentation_markdown;
#[cfg(test)]
mod presentation_marker_spacing_tests;
mod presentation_markers;
mod presentation_panels;
#[cfg(test)]
mod presentation_parity_tests;
mod presentation_status;
#[cfg(test)]
mod presentation_tests;
mod presentation_text;
mod presentation_welcome;
mod projection;
#[cfg(test)]
mod projection_tests;
mod selector;
mod session;
mod terminal;
mod transport;
#[cfg(test)]
mod transport_parity_tests;
#[cfg(test)]
mod transport_paste_tests;

pub use transport::{Request, Resume, run};
