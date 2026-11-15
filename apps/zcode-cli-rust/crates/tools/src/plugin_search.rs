//! 插件候选的纯排序/分页（TS `bootstrap/src/plugin-discovery/search.ts` 的等价实现）。
//!
//! 放在 tools 而不是 domain：需要 `unicode-normalization`（NFKC）与本文件既有依赖一致，
//! 避免为纯函数在 domain 增加依赖边；输入/意图规则仍在 domain `plugin_discovery`。
//!
//! 目录由调用方（既有插件 store 投影）提供；这里只做分词、BM25 打分与游标，不读配置、
//! 不查网络、不缓存第二份目录。
use zcode_cli_domain::plugin_discovery::{PAGE_SIZE, SearchInput};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

const VERSION: &str = "bm25-v1";
const NAME_WEIGHT: f64 = 4.0;
const K1: f64 = 1.2;
const DETAIL_B: f64 = 0.75;

static HAN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\p{Script=Han}$").expect("han class"));
static WORD: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[\p{L}\p{N}]$").expect("word class"));

fn normalize(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase().trim().to_owned()
}

/// 汉字按 bigram 切词（单字只有完整名称能命中）；其它语言的字母/数字按连续段。
fn tokens(value: &str) -> Vec<String> {
    let mut out = vec![];
    let mut han: Vec<char> = vec![];
    let mut word = String::new();
    let flush_han = |han: &mut Vec<char>, out: &mut Vec<String>| {
        for pair in han.windows(2) {
            out.push(format!("{}{}", pair[0], pair[1]));
        }
        han.clear();
    };
    for char in value.chars() {
        let text = char.to_string();
        if HAN.is_match(&text) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            han.push(char);
            continue;
        }
        flush_han(&mut han, &mut out);
        if WORD.is_match(&text) {
            word.push(char);
        } else if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
    }
    flush_han(&mut han, &mut out);
    if !word.is_empty() {
        out.push(word);
    }
    out
}

#[derive(Default)]
struct Field {
    matches: BTreeMap<String, f64>,
    length: usize,
}

fn field(values: &[String], query: &HashSet<String>, unique: bool) -> Field {
    let mut seen_terms: HashSet<String> = HashSet::new();
    let mut seen_values: HashSet<&String> = HashSet::new();
    let mut field = Field::default();
    for value in values {
        if !seen_values.insert(value) {
            continue;
        }
        for term in tokens(value) {
            if unique && !seen_terms.insert(term.clone()) {
                continue;
            }
            field.length += 1;
            if query.contains(&term) {
                *field.matches.entry(term).or_insert(0.0) += 1.0;
            }
        }
    }
    field
}

/// BM25 with Node's per-field parameters; returns a scoring closure.
fn scoring(fields: &[&Field], k1: f64, b: f64) -> impl Fn(&Field) -> f64 {
    let mut documents = 0usize;
    let mut total_length = 0usize;
    let mut df: BTreeMap<String, f64> = BTreeMap::new();
    for field in fields.iter().filter(|field| field.length > 0) {
        documents += 1;
        total_length += field.length;
        for term in field.matches.keys() {
            *df.entry(term.clone()).or_insert(0.0) += 1.0;
        }
    }
    let idf: BTreeMap<String, f64> = df
        .iter()
        .map(|(term, n)| {
            let documents = documents as f64;
            (term.clone(), ((documents - n + 0.5) / (n + 0.5)).ln_1p())
        })
        .collect();
    let average = if documents == 0 {
        0.0
    } else {
        total_length as f64 / documents as f64
    };
    move |field: &Field| {
        if field.length == 0 {
            return 0.0;
        }
        let norm = k1 * (1.0 - b + (b * field.length as f64) / average);
        let mut score = 0.0;
        for (term, tf) in &field.matches {
            let idf = idf.get(term).copied().unwrap_or(0.0);
            score += (idf * tf * (k1 + 1.0)) / (tf + norm);
        }
        score
    }
}

fn texts(entry: &Value, key: &str) -> Vec<String> {
    let mut out = vec![];
    if let Some(value) = entry[key].as_str() {
        out.push(value.to_owned());
    }
    if let Some(map) = entry[key].as_object() {
        out.extend(map.values().filter_map(Value::as_str).map(str::to_owned));
    }
    out
}

fn i18n(entry: &Value, key: &str) -> Vec<String> {
    entry[format!("{key}I18n")]
        .as_object()
        .map(|map| {
            map.values()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

struct Doc<'a> {
    entry: &'a Value,
    tier: u8,
    name: Field,
    detail: Field,
    score: f64,
}

fn rank<'a>(catalog: &'a [Value], query: &str) -> Vec<&'a Value> {
    let words: HashSet<String> = tokens(query).into_iter().collect();
    let mut docs = vec![];
    for entry in catalog {
        let name = entry["name"].as_str().unwrap_or_default();
        let plugin_id = entry["pluginId"].as_str().unwrap_or_default();
        let displays: Vec<String> = texts(entry, "displayName")
            .into_iter()
            .map(|value| normalize(&value))
            .collect();
        let mut name_values = vec![normalize(name)];
        name_values.extend(displays.iter().cloned());
        let tier = if query == normalize(name) || query == normalize(plugin_id) {
            2
        } else if !query.is_empty() && displays.iter().any(|display| display == query) {
            1
        } else {
            0
        };
        let mut detail_values: Vec<String> = texts(entry, "description")
            .into_iter()
            .chain(texts(entry, "category"))
            .chain(i18n(entry, "description"))
            .map(|value| normalize(&value))
            .collect();
        detail_values.extend(
            entry["examplePrompts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(normalize),
        );
        docs.push(Doc {
            entry,
            tier,
            name: field(&name_values, &words, true),
            detail: field(&detail_values, &words, false),
            score: 0.0,
        });
    }
    let names: Vec<&Field> = docs.iter().map(|doc| &doc.name).collect();
    let details: Vec<&Field> = docs.iter().map(|doc| &doc.detail).collect();
    let name_score = scoring(&names, K1, 0.0);
    let detail_score = scoring(&details, K1, DETAIL_B);
    for doc in &mut docs {
        doc.score = NAME_WEIGHT * name_score(&doc.name) + detail_score(&doc.detail);
    }
    docs.retain(|doc| doc.tier > 0 || doc.score > 0.0);
    docs.sort_by(|a, b| {
        let id = |doc: &Doc<'_>| doc.entry["pluginId"].as_str().unwrap_or_default().to_owned();
        b.tier
            .cmp(&a.tier)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| id(a).cmp(&id(b)))
    });
    docs.into_iter().map(|doc| doc.entry).collect()
}

/// 规范 JSON：对象键按字典序，避免目录重排使游标失效（TS 的 replacer 等价物）。
fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical(&map[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn revision(query: &str, catalog: &[Value]) -> String {
    let mut ordered: Vec<&Value> = catalog.iter().collect();
    ordered.sort_by_key(|entry| entry["pluginId"].as_str().unwrap_or_default().to_owned());
    let mut snapshot = String::new();
    canonical(&Value::Array(ordered.into_iter().cloned().collect()), &mut snapshot);
    let mut hash = Sha256::new();
    hash.update(format!("{VERSION}\u{0}{query}\u{0}{snapshot}"));
    format!("{VERSION}:{}", hex(&hash.finalize())[..24].to_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn localize(entry: &Value, key: &str, locale: &str) -> Option<String> {
    let translations = entry[format!("{key}I18n")].as_object();
    let value = entry[key].as_str().map(str::to_owned);
    if let Some(translations) = translations {
        if let Some(text) = translations.get(locale).and_then(Value::as_str) {
            return Some(text.to_owned());
        }
        let language = locale.split('-').next().unwrap_or(locale);
        if let Some(text) = translations.get(language).and_then(Value::as_str) {
            return Some(text.to_owned());
        }
    }
    value
}

fn truncated(value: Option<String>, max: usize) -> Option<String> {
    value.map(|text| text.chars().take(max).collect())
}

/// 一页搜索结果；`stale` 由目录新鲜度 owner 决定。
pub fn search(catalog: &[Value], input: &SearchInput, stale: bool) -> Result<Value, String> {
    let query = normalize(&input.query);
    let ranked = rank(catalog, &query);
    let revision = revision(&query, catalog);
    let mut offset = 0usize;
    if let Some(cursor) = &input.cursor {
        let Some((revision_part, offset_part)) = cursor.rsplit_once(':') else {
            return Err("plugin_search_cursor_invalid".into());
        };
        if revision_part != revision {
            return Err("plugin_search_cursor_expired: restart the search without a cursor".into());
        }
        offset = offset_part
            .parse::<usize>()
            .map_err(|_| "plugin_search_cursor_invalid".to_owned())?;
        if offset >= ranked.len() || offset % PAGE_SIZE != 0 {
            return Err("plugin_search_cursor_invalid".into());
        }
    }
    let locale = if query.chars().any(|char| HAN.is_match(&char.to_string())) {
        "zh-CN"
    } else {
        "en-US"
    };
    let page: Vec<Value> = ranked
        .iter()
        .skip(offset)
        .take(PAGE_SIZE)
        .map(|entry| {
            let mut plugin = Map::new();
            for (key, value) in [
                ("pluginId", entry["pluginId"].clone()),
                ("name", entry["name"].clone()),
            ] {
                plugin.insert(key.into(), value);
            }
            let display = truncated(localize(entry, "displayName", locale), 128);
            let description = truncated(localize(entry, "description", locale), 384);
            for (key, value) in [
                ("displayName", display),
                ("description", description),
            ] {
                if let Some(value) = value {
                    plugin.insert(key.into(), Value::String(value));
                }
            }
            for key in ["installed", "enabled", "action", "scope"] {
                plugin.insert(key.into(), entry[key].clone());
            }
            Value::Object(plugin)
        })
        .collect();
    let next = offset + page.len();
    let mut output = Map::new();
    output.insert("plugins".into(), Value::Array(page));
    output.insert("stale".into(), Value::Bool(stale));
    if next < ranked.len() {
        output.insert("cursor".into(), Value::String(format!("{revision}:{next}")));
    }
    Ok(json!(Value::Object(output)))
}

#[cfg(test)]
#[path = "plugin_search_tests.rs"]
mod tests;
