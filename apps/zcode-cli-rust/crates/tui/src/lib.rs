//! Native terminal frontend. Runtime facts stay owned by the core actor.
mod client;
#[cfg(test)]
mod client_session_tests;
mod editor;
mod interactions;
mod picker;
mod presentation;
mod presentation_markdown;
mod presentation_panels;
#[cfg(test)]
mod presentation_tests;
mod presentation_text;
mod projection;
#[cfg(test)]
mod projection_tests;
mod selector;
mod session;
mod terminal;
mod transport;

pub use transport::{Request, Resume, run};
