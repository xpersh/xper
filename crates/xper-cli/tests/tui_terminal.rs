//! Real terminal lifecycle checks using isolated POSIX pseudoterminals.
#![cfg(unix)]

use std::{io, process::Command};

#[test]
fn terminal_dashboard_lifecycle_and_configuration_authoring() {
    let output = Command::new("python3")
        .arg("-I")
        .arg("-c")
        .arg(include_str!("support/terminal_harness.py"))
        .arg(env!("CARGO_BIN_EXE_xper"))
        .arg(env!("CARGO_PKG_VERSION"))
        .arg(std::env::current_exe().expect("integration test executable is available"))
        .output()
        .expect("POSIX terminal integration checks require Python 3 (standard library only)");
    assert!(
        output.status.success(),
        "terminal lifecycle checks failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The PTY harness invokes this test in a separate process, never the product.
#[test]
fn lifecycle_probe() -> io::Result<()> {
    let Ok(mode) = std::env::var("XPER_TEST_TERMINAL_EXIT") else {
        return Ok(());
    };
    ratatui::run(|terminal| -> io::Result<()> {
        terminal.draw(|frame| {
            frame.render_widget("Lifecycle probe ready", frame.area());
        })?;
        crossterm::event::read()?;
        if mode == "panic" {
            panic!("synthetic terminal panic");
        }
        Err(io::Error::other("synthetic terminal error"))
    })
}
