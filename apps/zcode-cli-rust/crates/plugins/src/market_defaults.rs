//! Default marketplaces of the plugin storage: Node
//! `defaultMarketplaceSourceFromString`, `ensureDefaultPluginMarketplaces` and the
//! read-only default merge used by `plugins/overview`. Spec rust-m10-4-plugin-sources.
use crate::market::known;
use serde_json::{Value, json};
use std::path::Path;

/// Node `defaultMarketplaceSourceFromString`.
pub fn default_source(source: &str) -> Value {
    let trimmed = crate::js::trim(source);
    let shorthand = !trimmed.contains(':')
        && trimmed.split('/').count() == 2
        && trimmed.split('/').all(|part| !part.is_empty());
    if shorthand {
        let cut = trimmed.rfind(['#', '@']).filter(|i| *i > 0);
        return match cut {
            Some(i) => json!({"source":"github","repo":&trimmed[..i],"ref":&trimmed[i + 1..]}),
            None => json!({"source":"github","repo":trimmed}),
        };
    }
    json!({"source":"url","url":trimmed})
}

/// One default marketplace record (Node `ensureDefaultPluginMarketplaces` entry).
fn default_record(default: &Value, now: &str) -> Value {
    let mut record = json!({"id":default["id"],"source":default_source(default["source"].as_str().unwrap_or_default()),
        "name":default["name"],"description":default["description"],"addedAt":now,"pluginCount":default["pluginCount"]});
    if let Some(updated) = default.get("lastUpdated") {
        record["lastUpdated"] = updated.clone();
    }
    record
}

fn default_marketplaces() -> impl Iterator<Item = &'static Value> {
    crate::official::DATA["defaultMarketplaces"]
        .as_array()
        .into_iter()
        .flatten()
}

/// Node `loadKnownMarketplacesSync` for read paths: missing default records are
/// only merged in memory, so `plugins/overview` never writes the authority file
/// (and therefore never queues behind an install holding the storage lock).
/// Persisting stays with [`ensure_defaults`], which mutation paths call under
/// that lock.
pub async fn known_with_defaults(storage: &Path) -> std::io::Result<Vec<Value>> {
    let mut records = known(storage).await?;
    let now = crate::store::now();
    for default in default_marketplaces() {
        if records.iter().any(|r| r["id"] == default["id"]) {
            continue;
        }
        records.push(default_record(default, &now));
    }
    Ok(records)
}

/// Node `ensureDefaultPluginMarketplaces`: missing default records are
/// appended and the file rewritten in its array form.
pub async fn ensure_defaults(storage: &Path) -> std::io::Result<Vec<Value>> {
    let mut records = known(storage).await?;
    let now = crate::store::now();
    let mut changed = false;
    for default in default_marketplaces() {
        if records.iter().any(|r| r["id"] == default["id"]) {
            continue;
        }
        records.push(default_record(default, &now));
        changed = true;
    }
    if changed {
        let text = serde_json::to_string_pretty(&json!({"version":1,"marketplaces":records}))
            .expect("JSON serializes");
        tokio::fs::create_dir_all(storage).await?;
        tokio::fs::write(storage.join("known_marketplaces.json"), format!("{text}\n")).await?;
    }
    Ok(records)
}
