//! 插件发现候选：把既有插件 store 的目录投影成模型可见候选（无第二缓存）。
//!
//! 目录事实来自 `plugins::overview`（商店/安装态/可恢复内置），安装态与冲突来自既有
//! `plugins::discover`；写入口仍是 `plugins/install`、`plugins/setEnabled`（同一 storage 锁）。
//! 规范来源：`apps/zcode-cli/packages/bootstrap/src/plugin-discovery-store.ts`。
use super::tools::WorkspaceTools;
use anyhow::Result;
use serde_json::{Value, json};
use std::path::Path;
use tokio_util::sync::CancellationToken;
use zcode_cli_plugins as plugins;
use zcode_cli_plugins::official::MARKETPLACE;

const DESCRIPTION_LIMIT: usize = 4_000;
const I18N_LIMIT: usize = 2_000;
const EXAMPLE_LIMIT: usize = 20;
/// Node `REFRESH_INTERVAL_MS`：目录过期判定与既有刷新节流同一预算。
const REFRESH_INTERVAL_MS: u64 = 10 * 60_000;

/// 一次目录投影的配置事实（每次调用重新读取，不跨调用缓存）。
pub(super) struct Store {
    pub snapshot: super::extension_config::Snapshot,
    pub storage: std::path::PathBuf,
}

pub(super) async fn store(tools: &WorkspaceTools) -> Result<Store> {
    let snapshot = tools.config.load().await?;
    let storage = plugins::records::storage_root(&snapshot.config, &super::extension_config::home());
    Ok(Store { snapshot, storage })
}

fn bounded(value: Option<&str>, max: usize) -> Option<Value> {
    value
        .map(|text| Value::String(text.chars().take(max).collect()))
        .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
}

fn locale_map(value: Option<&Value>) -> Option<Value> {
    let map = value?.as_object()?;
    let entries: Vec<(&str, &Value)> = map.iter().take(20).collect();
    if entries.is_empty() {
        return None;
    }
    let mut bounded = serde_json::Map::new();
    for (locale, text) in entries {
        if let Some(text) = text
            .as_str()
            .map(|text| text.chars().take(I18N_LIMIT).collect::<String>())
        {
            bounded.insert(locale.clone(), Value::String(text));
        }
    }
    (!bounded.is_empty()).then_some(Value::Object(bounded))
}

fn examples(listing: &Value) -> Option<Value> {
    let mut out: Vec<Value> = listing["examplePrompts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|text| text.chars().take(1_000).collect::<String>())
        .collect();
    if let Some(map) = listing["examplePromptsI18n"].as_object() {
        for values in map.values() {
            for text in values.as_array().into_iter().flatten().filter_map(Value::as_str) {
                out.push(text.chars().take(1_000).collect());
            }
        }
    }
    out.truncate(EXAMPLE_LIMIT);
    (!out.is_empty()).then(|| Value::Array(out.into_iter().map(Value::String).collect()))
}

/// 既有目录 → 候选。冲突（同名启用插件）与重复条目整条剔除，模型拿到的 id 必须唯一。
pub(super) fn candidates(overview: &Value, outcome: &plugins::Outcome) -> Vec<Value> {
    let installed_description = |id: &str| {
        overview["installedPlugins"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == id)
            .and_then(|item| item["description"].as_str())
            .map(str::to_owned)
    };
    let mut seen: Vec<String> = vec![];
    let mut candidates = vec![];
    for section in ["availablePlugins", "restorableBuiltins"] {
        for entry in overview[section].as_array().into_iter().flatten() {
            if entry["marketplace"].as_str() != Some(MARKETPLACE) {
                continue;
            }
            let id = entry["id"].as_str().unwrap_or_default();
            if id.is_empty() || seen.iter().any(|seen| seen == id) {
                continue;
            }
            let loaded = outcome.plugins.iter().find(|plugin| plugin.loaded.id == id);
            // 同名且已启用的另一个插件：目录身份不唯一，整条剔除（fail closed）。
            let conflict = outcome.plugins.iter().any(|other| {
                other.enabled
                    && other.loaded.name() == entry["name"].as_str().unwrap_or_default()
                    && other.loaded.id != id
            });
            if conflict {
                continue;
            }
            seen.push(id.to_owned());
            let installed = loaded.is_some() || entry["installed"] == true;
            let enabled = loaded.is_some_and(|plugin| plugin.enabled);
            let listing = &entry["listing"];
            let mut candidate = json!({
                "pluginId": id,
                "name": entry["name"],
                "installed": installed,
                "enabled": enabled,
                "action": if enabled { "none" } else if installed { "enable" } else { "install" },
                // 会话内确认只授权当前 workspace（不含 user 级覆盖）。
                "scope": "workspace",
            });
            let description = entry["description"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| installed_description(id));
            let mut put = |key: &str, value: Option<Value>| {
                if let Some(value) = value {
                    candidate[key] = value;
                }
            };
            put("displayName", bounded(listing["displayName"].as_str(), 200));
            put("displayNameI18n", locale_map(Some(&listing["displayNameI18n"])));
            put("description", bounded(description.as_deref(), DESCRIPTION_LIMIT));
            put("descriptionI18n", locale_map(Some(&listing["descriptionI18n"])));
            put("icon", bounded(listing["icon"].as_str(), 2_000));
            put("category", bounded(listing["category"].as_str(), 200));
            put("examplePrompts", examples(listing));
            candidates.push(candidate);
        }
    }
    candidates
}

/// 一次完整投影：目录 + 官方市场是否过期（过期必须显式告知模型）。
pub(super) async fn read(
    tools: &WorkspaceTools,
    cancel: &CancellationToken,
) -> Result<(Vec<Value>, bool)> {
    let store = store(tools).await?;
    let env = super::plugin_requests::env_lookup(tools);
    let lookup = |name: &str| env.get(name).map(|value| (*value).to_owned());
    let request = plugins::Request {
        config: &store.snapshot.config,
        storage: &store.storage,
        cwd: &tools.cwd,
        env: &lookup,
        cancel,
    };
    let outcome = plugins::discover(&request).await?;
    let input = plugins::overview::Input {
        config: &store.snapshot.config,
        storage: &store.storage,
        user_path: Path::new(&store.snapshot.user_path),
        env: &lookup,
    };
    let overview = plugins::overview::overview(&input, &outcome).await?;
    let stale = official_stale(&store).await?;
    Ok((candidates(&overview, &outcome), stale))
}

/// 官方市场记录比刷新间隔更旧（或缺失）即过期。
async fn official_stale(store: &Store) -> Result<bool> {
    let known = plugins::market::known(&store.storage).await?;
    let updated = known
        .iter()
        .find(|record| record["id"].as_str() == Some(MARKETPLACE))
        .and_then(|record| record["lastUpdated"].as_u64());
    Ok(updated.is_none_or(|updated| {
        plugins::store::now().saturating_sub(updated) >= REFRESH_INTERVAL_MS
    }))
}

/// 既有 `plugins/marketplace/update`（同一 storage 锁内的唯一刷新 owner）。
pub(super) async fn refresh(tools: &WorkspaceTools, cancel: &CancellationToken) -> Result<()> {
    let params = json!({"marketplace": MARKETPLACE});
    let result = super::plugin_admin::handle(tools, "plugins/marketplace/update", &params, cancel)
        .await?;
    if let Some(failure) = result["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|diagnostic| diagnostic["severity"] == "error")
    {
        anyhow::bail!(
            "official marketplace refresh failed: {}",
            failure["message"].as_str().unwrap_or_default()
        );
    }
    Ok(())
}

/// 重新解析单个候选（确认前后各一次，状态变化即拒绝执行）。
pub(super) async fn resolve(
    tools: &WorkspaceTools,
    cancel: &CancellationToken,
    plugin_id: &str,
) -> Result<Option<Value>> {
    let (catalog, _) = read(tools, cancel).await?;
    Ok(catalog
        .into_iter()
        .find(|candidate| candidate["pluginId"] == plugin_id))
}

/// 已确认后的写入：安装走既有 `plugins/install`，启用走既有 `plugins/setEnabled`。
pub(super) async fn apply(
    tools: &WorkspaceTools,
    cancel: &CancellationToken,
    candidate: &Value,
) -> Result<bool> {
    let plugin_id = candidate["pluginId"].as_str().unwrap_or_default();
    let action = candidate["action"].as_str().unwrap_or_default();
    if action == "none" {
        return Ok(false);
    }
    if action == "install" {
        let (name, marketplace) = plugin_id
            .rsplit_once('@')
            .ok_or_else(|| anyhow::anyhow!("plugin_no_longer_available"))?;
        let params = json!({"marketplace":marketplace,"pluginName":name});
        let result = super::plugin_admin::handle(tools, "plugins/install", &params, cancel).await?;
        if let Some(failure) = result["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|diagnostic| diagnostic["severity"] == "error")
        {
            anyhow::bail!("{}", failure["message"].as_str().unwrap_or_default());
        }
        if result["installedPlugins"]
            .as_array()
            .is_none_or(|items| items.is_empty())
        {
            anyhow::bail!("plugin_install_empty");
        }
    }
    let params = json!({"pluginId":plugin_id,"enabled":true,"scope":candidate["scope"]});
    super::plugin_requests::handle(tools, "plugins/setEnabled", &params, cancel).await?;
    // 写入后复验：装上了但没启用（或反过来）都不算成功。
    let current = resolve(tools, cancel, plugin_id).await?;
    match current {
        Some(candidate) if candidate["installed"] == true && candidate["enabled"] == true => Ok(true),
        _ => anyhow::bail!("plugin_install_verification_failed"),
    }
}
