//! Native terminal frontend. Runtime facts stay owned by the core actor.
mod client;
#[cfg(test)]
mod client_session_tests;
mod editor;
mod interactions;
mod projection;
#[cfg(test)]
mod projection_tests;
mod session;
mod terminal;
mod transport;

pub use transport::{Request, Resume, run};
