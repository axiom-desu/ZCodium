//! Component inventory of one marketplace plugin for the store detail view
//! (Node `describeMarketplacePlugin`, `readComponentsAtRoot`,
//! `toManifestDisplayMetadata`). Spec rust-m10-4-plugin-sources §8.
use crate::diagnose;
use crate::manifest::{Diagnostic, Severity};
use crate::market::Entry;
use crate::plugin_source;
use crate::ports::Ports;
use serde_json::{Map, Value, json};
use std::path::Path;

pub struct Described {
    pub components: Vec<crate::components::Group>,
    pub diagnostics: Vec<Diagnostic>,
    pub metadata: Option<Value>,
}

/// Node `toManifestDisplayMetadata`.
fn metadata(manifest: &Value) -> Option<Value> {
    let mut fields = Map::new();
    if let Some((name, url)) = crate::manifest::author(&manifest["author"]) {
        if let Some(name) = name {
            fields.insert("author".into(), name.into());
        }
        if let Some(url) = url {
            fields.insert("authorUrl".into(), url.into());
        }
    }
    if let Some(homepage) = crate::manifest::text(&manifest["homepage"]) {
        fields.insert("homepage".into(), homepage.into());
    }
    if let Some(version) = manifest["version"].as_str().filter(|v| !v.is_empty()) {
        fields.insert("version".into(), version.into());
    }
    (!fields.is_empty()).then_some(Value::Object(fields))
}

/// Node `readComponentsAtRoot`: an unreadable manifest degrades to the
/// default directory conventions.
async fn at_root(
    root: &Path,
    entry: &Entry,
    marketplace: &str,
    out: &mut Vec<Diagnostic>,
) -> Described {
    let loaded = crate::entry_manifest::read(root, entry)
        .await
        .ok()
        .flatten();
    let plugin = loaded.as_ref().map(|loaded| crate::loaded::Loaded {
        id: format!(
            "{}@{marketplace}",
            loaded.manifest["name"].as_str().unwrap_or_default()
        ),
        manifest: loaded.manifest.clone(),
        manifest_path: loaded.path.clone().unwrap_or_else(|| root.to_owned()),
        marketplace: marketplace.to_owned(),
        root: root.to_owned(),
        source: crate::loaded::Source::Cache,
    });
    let manifest = loaded.as_ref().map(|l| &l.manifest);
    let components = crate::components::enumerate(root, manifest, plugin.as_ref(), Some(out)).await;
    Described {
        components,
        diagnostics: vec![],
        metadata: manifest.and_then(metadata),
    }
}

fn finish(mut described: Described, diagnostics: Vec<Diagnostic>) -> Described {
    described.diagnostics = diagnostics;
    described
}

fn failed(diagnostics: Vec<Diagnostic>) -> Described {
    Described {
        components: vec![],
        diagnostics,
        metadata: None,
    }
}

/// Cached manifests are read without the storage lock; a missing manifest is
/// filled lazily under the existing storage lock with a second check, so
/// concurrent readers of one unknown marketplace only fetch it once.
///
/// Bugfix（对齐上游 3.16.2）：describe 曾在调用方持整个 storage lock，安装 A 下载期间
/// 已缓存市场的详情全部排队。读路径不再进锁，写路径仍沿同一把锁，没有第二套锁权威。
async fn manifest_for_read(
    ports: &Ports<'_>,
    marketplace: &str,
) -> anyhow::Result<Option<crate::market::Manifest>> {
    if let Some(manifest) = crate::market::manifest(ports.storage, marketplace).await? {
        return Ok(Some(manifest));
    }
    let _guard = crate::atomic_write::lock(ports.storage).await;
    crate::failure::check(ports.cancel)?;
    if crate::market::manifest(ports.storage, marketplace)
        .await?
        .is_none()
    {
        // 默认市场登记与市场快照都在锁内完成（`ensure_available` → `ensure_defaults`/`add`）。
        crate::marketplace_ops::ensure_available(ports, marketplace).await?;
    }
    Ok(crate::market::manifest(ports.storage, marketplace).await?)
}

/// Node `describeMarketplacePlugin`: an installed cache is read locally,
/// otherwise the source is resolved (possibly cloned) and cleaned up.
/// Only the lazy manifest write takes the storage lock (see [`manifest_for_read`]).
pub async fn describe(ports: &Ports<'_>, marketplace: &str, name: &str) -> Described {
    let id = format!("{name}@{marketplace}");
    let mut diagnostics = vec![];
    let placeholder = crate::market::parse_manifest(
        &json!({"name":"describe","plugins":[{"name":"__describe__"}]}),
    )
    .expect("valid placeholder")
    .plugins
    .remove(0);
    if let Ok(records) = crate::records::installed(ports.storage).await
        && let Some(record) = records
            .iter()
            .find(|r| r.marketplace == marketplace && r.name == name)
        && let Ok(root) = crate::records::installed_root(ports.storage, record).await
        && crate::fsx::is_dir(&root).await
    {
        let described = at_root(&root, &placeholder, marketplace, &mut diagnostics).await;
        return finish(described, diagnostics);
    }
    // 安装记录存在但缓存被清理时，继续走来源解析兜底。
    let manifest = match manifest_for_read(ports, marketplace).await {
        Ok(manifest) => manifest,
        Err(error) => return failed(vec![diagnose::validation(&error, Some(&id))]),
    };
    let path = crate::store::market_manifest(ports.storage, marketplace);
    let manifest = match manifest {
        Some(manifest) => manifest,
        None => {
            let message = format!("Marketplace not found: {marketplace}");
            let diagnostic =
                Diagnostic::new("plugin_marketplace_invalid", Severity::Error, message);
            return failed(vec![diagnostic.at(path)]);
        }
    };
    let Some(entry) = manifest.plugins.iter().find(|p| p.name == name) else {
        let message = format!("Plugin not found: {id}");
        return failed(vec![
            Diagnostic::new("plugin_not_found", Severity::Error, message).at(path),
        ]);
    };
    let input = plugin_source::Input {
        entry,
        marketplace,
        source_root: None,
        manifest: None,
    };
    match plugin_source::resolve(&input, ports).await {
        Ok(resolved) => {
            let described = at_root(&resolved.path, entry, marketplace, &mut diagnostics).await;
            crate::store::cleanup(resolved.cleanup.as_deref()).await;
            finish(described, diagnostics)
        }
        Err(error) => {
            diagnostics.push(diagnose::validation(&error, Some(&id)));
            failed(diagnostics)
        }
    }
}

/// Protocol `ZCodePluginsDescribeResult`.
pub fn protocol(described: &Described) -> Value {
    let mut result =
        json!({"components":described.components.iter().map(|g| g.protocol()).collect::<Vec<_>>()});
    if !described.diagnostics.is_empty() {
        result["diagnostics"] = described
            .diagnostics
            .iter()
            .map(Diagnostic::protocol)
            .collect();
    }
    if let Some(metadata) = &described.metadata {
        result["metadata"] = metadata.clone();
    }
    result
}

#[cfg(test)]
#[path = "describe_tests.rs"]
mod tests;
