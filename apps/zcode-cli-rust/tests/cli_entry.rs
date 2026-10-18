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
fn standalone_without_models_reports_setup_instead_of_unavailable_selection() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join(".zcodium-exp/v2/runtime/provider/bundled");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("zcode-builtin.json"),
        r#"{"schemaVersion":1,"revision":1,"config":{}}"#,
    )
    .unwrap();
    let output = binary()
        .args(["-p", "fixture"])
        .current_dir(root.path())
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("ZCODE_DATA_BASE_DIR", root.path())
        .env("ZCODE_STORAGE_DIR", root.path().join("storage"))
        .env("ZCODE_SESSION_DB_PATH", root.path().join("db.sqlite"))
        .env_remove("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")
        .env_remove("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("Configure a personal model in ZCodium Settings"),
        "{error}"
    );
    assert!(!error.contains("Selected model is unavailable"));
}

#[test]
fn app_server_still_requires_stdio_transport() {
    let output = binary().args(["app-server"]).output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
