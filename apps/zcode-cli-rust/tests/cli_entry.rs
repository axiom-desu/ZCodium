use std::process::Command;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_zcode-cli-rust"))
}

#[test]
fn interactive_entries_fail_before_runtime_without_a_terminal() {
    for args in [
        Vec::<&str>::new(),
        vec!["tui"],
        vec!["tui", "--cwd", "/missing"],
    ] {
        let output = binary().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("requires a terminal"));
    }
}

#[test]
fn non_tty_tui_flags_do_not_create_or_open_the_session_library() {
    let data_dir = std::env::temp_dir().join(format!("zcode-cli-nontty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data_dir);
    let output = binary()
        .args(["tui", "--data-dir"])
        .arg(&data_dir)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires a terminal"));
    assert!(
        !data_dir.exists(),
        "non-TTY invocation must fail before library access"
    );
}

#[test]
fn help_and_version_do_not_require_a_terminal() {
    for args in [vec!["--help"], vec!["--version"], vec!["tui", "--help"]] {
        let output = binary().args(args).output().unwrap();
        assert!(output.status.success());
    }
}

#[test]
fn app_server_still_requires_stdio_transport() {
    let output = binary().args(["app-server"]).output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
