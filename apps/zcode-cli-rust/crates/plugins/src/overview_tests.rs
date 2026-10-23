//! `plugins/overview` classification and read-lane regressions (upstream
//! 3.16.2: bundled document plugins keep the `ui` component type including the
//! restorable entries, and overview never writes the marketplace authority).
use crate::discovery::Outcome;
use serde_json::json;

fn env_from<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + Sync + 'a {
    move |key| {
        vars.iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| (*value).to_owned())
    }
}

fn input<'a>(
    config: &'a serde_json::Value,
    storage: &'a std::path::Path,
    user_path: &'a std::path::Path,
    env: &'a (dyn Fn(&str) -> Option<String> + Sync),
) -> super::Input<'a> {
    super::Input {
        config,
        storage,
        user_path,
        env,
    }
}

#[tokio::test]
async fn catalog_and_restorable_entries_keep_the_ui_component_type() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dir.path().join("plugins");
    let official = crate::official::MARKETPLACE;
    let markets = crate::store::market_dir(&storage, official);
    tokio::fs::create_dir_all(&markets).await.unwrap();
    // 官方 seed 条目声明 "ui"；已卸载（抑制）后的可恢复条目没有 manifest，只能靠 definition。
    tokio::fs::write(
        markets.join("marketplace.json"),
        serde_json::to_string(&json!({"name":official,"plugins":[
            {"name":"documents","version":"0.1.8","componentTypes":["ui"],"skills":["docx"]},
            {"name":"plain","version":"1.0.0","skills":["plain"]}]}))
        .unwrap(),
    )
    .await
    .unwrap();
    let config = json!({"plugins":{"enabledPlugins":{},
        "suppressedBuiltins":["documents@zcode-plugins-official"]}});
    let env = env_from(&[]);
    let overview = super::overview(
        &input(&config, &storage, &dir.path().join("config.json"), &env),
        &Outcome::default(),
    )
    .await
    .unwrap();
    let available = overview["availablePlugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == "documents@zcode-plugins-official")
        .expect("documents entry");
    assert_eq!(available["componentTypes"], json!(["skill", "ui"]));
    let restorable = overview["restorableBuiltins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == "documents@zcode-plugins-official")
        .expect("documents restorable entry");
    assert_eq!(restorable["componentTypes"], json!(["ui"]));
    let plain = overview["availablePlugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == "plain@zcode-plugins-official")
        .expect("plain entry");
    assert_eq!(plain["componentTypes"], json!(["skill"]));
}

#[tokio::test]
async fn overview_reads_defaults_without_writing_the_authority_file() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dir.path().join("plugins");
    let config = json!({"plugins":{"enabledPlugins":{}}});
    let env = env_from(&[]);
    let overview = super::overview(
        &input(&config, &storage, &dir.path().join("config.json"), &env),
        &Outcome::default(),
    )
    .await
    .unwrap();
    // 默认市场仍出现在读投影里（内存补齐），但读路径不得无锁改写 authority 文件。
    assert!(
        overview["marketplaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|marketplace| marketplace["id"] == crate::official::MARKETPLACE)
    );
    assert!(
        !storage.join(crate::store::KNOWN_MARKETPLACES).exists(),
        "overview 不能写 known_marketplaces.json"
    );
}

#[tokio::test]
async fn computer_use_restorable_entry_keeps_the_cua_gate() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dir.path().join("plugins");
    let config = json!({"plugins":{"enabledPlugins":{},
        "suppressedBuiltins":["computer-use@zcode-plugins-official"]}});
    let user_path = dir.path().join("config.json");
    for (helper, expected) in [("0", false), ("1", true)] {
        let vars = [("ZCODE_CUA_PRODUCT_HELPER", helper)];
        let env = env_from(&vars);
        let overview = super::overview(
            &input(&config, &storage, &user_path, &env),
            &Outcome::default(),
        )
        .await
        .unwrap();
        let restorable = overview["restorableBuiltins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plugin| plugin["id"] == "computer-use@zcode-plugins-official");
        assert_eq!(restorable, expected, "ZCODE_CUA_PRODUCT_HELPER={helper}");
    }
}

/// 已安装插件的 UI 分类只能来自插件清单 `ui.surfaces[]`：可恢复项没有 manifest 才走 definition，
/// 已安装/已禁用但保留清单的插件必须同样归入「UI 插件」（否则安装后从分组里掉出去）。
#[tokio::test]
async fn installed_plugin_keeps_the_ui_component_type_from_manifest_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dir.path().join("plugins");
    tokio::fs::create_dir_all(&storage).await.unwrap();
    tokio::fs::write(
        storage.join("installed_plugins.json"),
        serde_json::to_string(&json!({"version":1,"plugins":[{
            "id":"documents@zcode-plugins-official","name":"documents",
            "marketplace":crate::official::MARKETPLACE,"version":"0.1.8",
            "installPath":"cache/zcode-plugins-official/documents/0.1.8",
            "installedAt":"2026-01-01T00:00:00.000Z","scope":"user"}]}))
        .unwrap(),
    )
    .await
    .unwrap();
    let mut outcome = Outcome::default();
    outcome.plugins.push(installed_plugin(json!({
        "name":"documents",
        "version":"0.1.8",
        "ui":{"surfaces":[{"id":"docx-editor","server":"documents"}]}})));
    let config = json!({"plugins":{"enabledPlugins":{}}});
    let env = env_from(&[]);
    let overview = super::overview(
        &input(&config, &storage, &dir.path().join("config.json"), &env),
        &outcome,
    )
    .await
    .unwrap();
    let installed = overview["installedPlugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == "documents@zcode-plugins-official")
        .expect("installed documents record");
    assert_eq!(installed["componentTypes"], json!(["ui"]));
}

/// 已安装插件：manifest 由发现阶段读入，分类不另建缓存。
fn installed_plugin(manifest: serde_json::Value) -> crate::discovery::Plugin {
    crate::discovery::Plugin {
        loaded: crate::loaded::Loaded {
            id: "documents@zcode-plugins-official".into(),
            manifest,
            manifest_path: std::path::PathBuf::from("/w/plugin.json"),
            marketplace: crate::official::MARKETPLACE.into(),
            root: std::path::PathBuf::from("/w"),
            source: crate::loaded::Source::Cache,
        },
        enabled: true,
        data_path: std::path::PathBuf::from("/w/data"),
        components: vec![],
        declared_mcp: vec![],
        mcp_server_names: vec![],
        hook_details: vec![],
        skill_count: 0,
        skill_root_count: 0,
        command_root_count: 0,
        configured_options: serde_json::Map::new(),
    }
}
