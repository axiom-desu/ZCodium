//! Node `core/src/tool/search/search.ts`：选择/关键词搜索与稳定评分。
use super::Candidate;

/// Node `toModelVisibleMcpNamePart`：MCP 名字在模型侧可见的规范化短名。
pub fn model_visible_mcp_part(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    // 连续下划线压缩为一个；保留首尾（上游只压缩 `_+`）。
    let mut collapsed = String::with_capacity(out.len());
    let mut previous_underscore = false;
    for ch in out.chars() {
        if ch == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        collapsed.push(ch);
    }
    if collapsed.is_empty() {
        "unknown".into()
    } else {
        collapsed
    }
}

struct Tokens {
    coarse: Vec<String>,
    parts: Vec<String>,
    full: String,
    mcp: bool,
}

fn tokenize(tool: &Candidate) -> Tokens {
    let mcp = tool.mcp.clone().or_else(|| mcp_from_name(&tool.name));
    let (coarse, parts): (Vec<String>, Vec<String>) = match &mcp {
        Some(mcp) => {
            let coarse = vec![mcp.server_name.to_lowercase(), mcp.tool_name.to_lowercase()];
            let parts = coarse
                .iter()
                .flat_map(|value| split_mcp(value))
                .collect::<Vec<_>>();
            (coarse, parts)
        }
        None => {
            let spaced = camel_split(&tool.name.replace('_', " "));
            let parts = spaced
                .to_lowercase()
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let coarse = vec![tool.name.to_lowercase()];
            (coarse, parts)
        }
    };
    let full = parts.join(" ");
    Tokens {
        coarse,
        parts,
        full,
        mcp: mcp.is_some(),
    }
}

/// Node `/^mcp__(.+?)__(.+)$/`。
fn mcp_from_name(name: &str) -> Option<super::McpName> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some(super::McpName {
        server_name: server.into(),
        tool_name: tool.into(),
    })
}

/// Node `s.split(/[\s_.]+/).filter(Boolean)`。
fn split_mcp(value: &str) -> Vec<String> {
    value
        .split([' ', '\t', '\n', '\r', '_', '.'])
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Node `name.replace(/([a-z])([A-Z])/g, "$1 $2")`。
fn camel_split(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len());
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && chars[index - 1].is_ascii_lowercase() && ch.is_ascii_uppercase() {
            out.push(' ');
        }
        out.push(*ch);
    }
    out
}

/// Node `resolveName`：精确名或别名。
fn resolve<'a>(name: &str, catalog: &'a [Candidate]) -> Option<&'a Candidate> {
    catalog
        .iter()
        .find(|tool| tool.name == name || tool.aliases.iter().any(|alias| alias == name))
}

/// JS `\s` 字符集（含 BOM；不含 Rust `char::is_whitespace` 的 NEL）。
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}

/// Node `/^select:(.+)$/i`：`.+` 不跨行，`$` 只匹配输入末尾。
fn select_rest(query: &str) -> Option<&str> {
    let head = query.get(..7)?;
    if !head.eq_ignore_ascii_case("select:") {
        return None;
    }
    let rest = &query[7..];
    (!rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(rest)
}

/// JS `\w`：只有 ASCII 字母、数字和下划线。
fn js_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// JS `/\bterm\b/`（term 已转义为字面量）：`\b` 按 JS ASCII `\w` 判定。
fn literal_word_match(term: &str, text: &str) -> bool {
    let Some(first) = term.chars().next() else {
        return false;
    };
    let last = term.chars().next_back().unwrap_or(first);
    text.match_indices(term).any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + term.len()..].chars().next();
        js_word(before) != js_word(Some(first)) && js_word(Some(last)) != js_word(after)
    })
}

/// JS `Array#slice(0, end)` 的长度：负数从末尾倒数，小数向零截断。
fn js_slice_len(len: usize, end: i64) -> usize {
    if end >= 0 {
        usize::try_from(end).unwrap_or(usize::MAX).min(len)
    } else {
        len.saturating_sub(usize::try_from(end.unsigned_abs()).unwrap_or(usize::MAX))
    }
}

/// Node `searchTools`：返回有序、去重的工具名。
pub fn search_tools(query: &str, catalog: &[Candidate], max_results: i64) -> Vec<String> {
    let deferred: Vec<Candidate> = catalog
        .iter()
        .filter(|tool| tool.deferred)
        .cloned()
        .collect();
    if let Some(rest) = select_rest(query) {
        let mut out: Vec<String> = vec![];
        for value in rest.split(',') {
            let name = js_trim(value);
            let exact = resolve(name, &deferred).or_else(|| resolve(name, catalog));
            if let Some(exact) = exact {
                if !out.contains(&exact.name) {
                    out.push(exact.name.clone());
                }
                continue;
            }
            for tool in catalog {
                let Some(mcp) = &tool.mcp else { continue };
                if (mcp.tool_name == name || model_visible_mcp_part(&mcp.tool_name) == name)
                    && !out.contains(&tool.name)
                {
                    out.push(tool.name.clone());
                }
            }
        }
        return out;
    }
    let text = query.to_lowercase();
    let text = js_trim(&text);
    let exact = deferred
        .iter()
        .chain(catalog.iter())
        .find(|tool| tool.name.to_lowercase() == text);
    if let Some(exact) = exact {
        return vec![exact.name.clone()];
    }
    if text.starts_with("mcp__") && text.len() > 5 {
        let mut names: Vec<String> = deferred
            .iter()
            .filter(|tool| tool.name.to_lowercase().starts_with(text))
            .map(|tool| tool.name.clone())
            .collect();
        names.truncate(js_slice_len(names.len(), max_results));
        if !names.is_empty() {
            return names;
        }
    }
    let terms: Vec<&str> = text
        .split(js_whitespace)
        .filter(|term| !term.is_empty())
        .collect();
    let required: Vec<&str> = terms
        .iter()
        .copied()
        .filter(|term| term.starts_with('+') && term.len() > 1)
        .map(|term| &term[1..])
        .collect();
    let keywords: Vec<&str> = if required.is_empty() {
        terms.clone()
    } else {
        required
            .iter()
            .copied()
            .chain(
                terms
                    .iter()
                    .copied()
                    .filter(|term| !(term.starts_with('+') && term.len() > 1)),
            )
            .collect()
    };
    let word = |term: &str, text: &str| literal_word_match(term, text);
    let matches = |term: &str, name: &Tokens, text: &str| -> bool {
        name.parts.iter().any(|part| part.contains(term))
            || name.coarse.iter().any(|part| part.contains(term))
            || word(term, text)
    };
    let mut scored: Vec<(String, i64)> = deferred
        .iter()
        .map(|tool| {
            let name = tokenize(tool);
            let description = tool.description.to_lowercase();
            let hint = tool.search_hint.clone().unwrap_or_default().to_lowercase();
            if !required
                .iter()
                .all(|term| matches(term, &name, &description) || matches(term, &name, &hint))
            {
                return (tool.name.clone(), 0);
            }
            let mut score = 0i64;
            for term in &keywords {
                let name_weight = if name.mcp { 12 } else { 10 };
                let partial_weight = if name.mcp { 6 } else { 5 };
                let coarse_weight = if name.mcp { 12 } else { 10 };
                let coarse_partial = if name.mcp { 4 } else { 3 };
                if name.parts.iter().any(|part| part == term) {
                    score += name_weight;
                } else if name.parts.iter().any(|part| part.contains(term)) {
                    score += partial_weight;
                }
                if name.coarse.iter().any(|part| part == term) {
                    score += coarse_weight;
                } else if name.coarse.iter().any(|part| part.contains(term)) {
                    score += coarse_partial;
                }
                if name.full.contains(term) && score == 0 {
                    score += 3;
                }
                if !hint.is_empty() && word(term, &hint) {
                    score += 4;
                }
                if word(term, &description) {
                    score += 2;
                }
            }
            (tool.name.clone(), score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    // JS Array#sort 在 V8 上是稳定排序；用同分保留目录顺序的稳定排序。
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let mut out: Vec<String> = scored.into_iter().map(|(name, _)| name).collect();
    out.truncate(js_slice_len(out.len(), max_results));
    out
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
