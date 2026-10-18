use super::*;

fn env(home: &Path, vars: &[(&str, &str)]) -> RuntimeEnv {
    RuntimeEnv::capture(
        vars.iter().map(|(k, v)| (k.to_string(), v.to_string())),
        home,
        &[],
    )
}
async fn file(path: &Path) {
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(path, "fixture").await.unwrap();
}

#[tokio::test]
async fn explicit_paths_are_independent_and_never_fall_back() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let builtin = home.join(".zcodium-exp/v2/runtime/provider/bundled/zcode-builtin.json");
    file(&builtin).await;
    let vars = env(
        home,
        &[(
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
            " missing-explicit.json ",
        )],
    );
    let paths = discover(
        home,
        &vars,
        Path::new("/installed/resources/rust/cli"),
        home,
    )
    .await
    .unwrap();
    assert_eq!(paths.builtin, Path::new("missing-explicit.json"));
    assert_eq!(
        paths.personal,
        home.join(".zcodium-exp/v2/provider_config.json")
    );
    let vars = env(
        home,
        &[
            (
                "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
                "custom-personal.json",
            ),
            ("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "  "),
        ],
    );
    let paths = discover(
        home,
        &vars,
        Path::new("/installed/resources/rust/cli"),
        home,
    )
    .await
    .unwrap();
    assert_eq!(paths.builtin, builtin);
    assert_eq!(paths.personal, Path::new("custom-personal.json"));
}

#[tokio::test]
async fn canonical_materialized_config_and_data_base_win_over_package() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let base = root.path().join("data");
    let builtin = base.join(".zcodium-exp/v2/runtime/provider/bundled/zcode-builtin.json");
    file(&builtin).await;
    let package = root.path().join("package/resources");
    file(&package.join("config/provider/zcode-builtin.json")).await;
    let vars = env(&home, &[("ZCODE_DATA_BASE_DIR", base.to_str().unwrap())]);
    let paths = discover(&home, &vars, &package.join("rust/cli"), root.path())
        .await
        .unwrap();
    assert_eq!(paths.builtin, builtin);
    assert_eq!(
        paths.personal,
        base.join(".zcodium-exp/v2/provider_config.json")
    );
}

#[tokio::test]
async fn both_packaged_layouts_are_resolved_without_cwd_or_checkout_fallback() {
    for layout in ["config", "glm"] {
        let root = tempfile::tempdir().unwrap();
        let resources = root.path().join("resources");
        let builtin = resources.join(layout).join("provider/zcode-builtin.json");
        file(&builtin).await;
        let paths = discover(
            root.path(),
            &env(root.path(), &[]),
            &resources.join("rust/cli"),
            root.path(),
        )
        .await
        .unwrap();
        assert_eq!(paths.builtin, builtin);
    }
}

#[tokio::test]
async fn only_a_cargo_binary_under_its_checkout_uses_source_config() {
    let root = tempfile::tempdir().unwrap();
    let checkout = root.path().join("apps/zcode-cli-rust");
    let builtin = root.path().join("config/provider/zcode-builtin.json");
    file(&builtin).await;
    let vars = env(root.path(), &[]);
    let paths = discover(
        root.path(),
        &vars,
        &checkout.join("target/debug/zcode-cli-rust"),
        &checkout,
    )
    .await
    .unwrap();
    assert_eq!(paths.builtin, builtin);
    assert!(
        discover(
            root.path(),
            &vars,
            &root.path().join("installed/resources/rust/cli"),
            &checkout
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn a_bad_canonical_candidate_is_not_hidden_by_packaged_config() {
    let root = tempfile::tempdir().unwrap();
    let materialized = root
        .path()
        .join(".zcodium-exp/v2/runtime/provider/bundled/zcode-builtin.json");
    tokio::fs::create_dir_all(materialized).await.unwrap();
    file(
        &root
            .path()
            .join("resources/config/provider/zcode-builtin.json"),
    )
    .await;
    let result = discover(
        root.path(),
        &env(root.path(), &[]),
        &root.path().join("resources/rust/cli"),
        root.path(),
    )
    .await;
    assert!(result.is_err());
}
