//! System actions. Each module defines one operation's typed request and result.
//!
//! Interfaces translate their inputs before calling `execute`; use cases load
//! state, apply workflow policy, and commit complete boundaries through ports.

pub mod advance_run;
pub mod finish_attempt;
pub mod get_run_status;
pub mod initialize_workspace;
pub mod inspect_installation;
pub mod start_discovery;
pub mod start_run;

mod support;
