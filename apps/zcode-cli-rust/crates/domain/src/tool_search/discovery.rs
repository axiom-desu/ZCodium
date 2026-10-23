//! 发现集与公告增量的历史事实（Node `tool/search/history.ts` 的收集部分 +
//! `tool-search-hydration.ts` 的严格校验）。
use super::{ANNOUNCEMENT_KEY, DEFERRED_TOOL_CALL_NAME};
use serde_json::Value;
use std::collections::BTreeSet;

/// 公告的增量事实（Node `ToolSearchAnnouncementSchema`）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Announcement {
    pub added_names: Vec<String>,
    pub removed_names: Vec<String>,
    pub readded_names: Vec<String>,
}

impl Announcement {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "addedNames": self.added_names,
            "removedNames": self.removed_names,
            "readdedNames": self.readded_names,
        })
    }
    /// 严格读取：三个数组都存在、去重排序、readded ⊆ added（顺序不强制，读时排序）。
    pub fn from_value(value: &Value) -> Option<Self> {
        let names = |key: &str| -> Option<Vec<String>> {
            let array = value.get(key)?.as_array()?;
            let mut out = vec![];
            for item in array {
                let name = item.as_str().filter(|name| !name.is_empty())?;
                out.push(name.to_owned());
            }
            if out.iter().collect::<BTreeSet<_>>().len() != out.len() {
                return None;
            }
            out.sort();
            Some(out)
        };
        let announcement = Self {
            added_names: names("addedNames")?,
            removed_names: names("removedNames")?,
            readded_names: names("readdedNames")?,
        };
        announcement
            .readded_names
            .iter()
            .all(|name| announcement.added_names.contains(name))
            .then_some(announcement)
    }
}

/// 历史里的发现集：真实成功结果中的引用 + 有效 compact 检查点。
/// Node `collectToolSearchHistory` 不限定产出引用的工具：普通工具结果里的
/// `tool_reference` 同样计入（导入/重写历史可能来自任意已提交成功结果）。
pub fn collect_discovered(messages: &[Value], compact_discovered: &[String]) -> BTreeSet<String> {
    let mut discovered: BTreeSet<String> = compact_discovered.iter().cloned().collect();
    for message in messages {
        if message["role"] != "tool" || message["_zcode_tool_failed"] == true {
            continue;
        }
        let Some(blocks) = message["content"].as_array() else {
            continue;
        };
        for block in blocks {
            if let Some(name) = history_reference_name(block) {
                discovered.insert(name.to_owned());
            }
        }
    }
    discovered
}

/// 严格引用块 `{type:"tool_reference", toolName}`（持久化 modelContent 校验）。
pub fn tool_reference_name(block: &Value) -> Option<&str> {
    if block["type"] != "tool_reference" {
        return None;
    }
    if block.as_object().is_some_and(|object| object.len() != 2) {
        return None;
    }
    block["toolName"].as_str().filter(|name| !name.is_empty())
}

/// 历史发现扫描的引用读取：Node 只检查 `block.type === "tool_reference"` 并取
/// `toolName`，不要求块恰好两个键；严格形状留给持久化 modelContent 校验。
fn history_reference_name(block: &Value) -> Option<&str> {
    if block["type"] != "tool_reference" {
        return None;
    }
    block["toolName"].as_str().filter(|name| !name.is_empty())
}

/// 严格持久化 modelContent（Node `PersistedToolSearchContentSchema`）：
/// 非空数组，元素只能是 `{type:"text",text}` 或 `{type:"tool_reference",toolName}`。
pub fn model_content(value: &Value) -> Option<Value> {
    let blocks = value.as_array().filter(|blocks| !blocks.is_empty())?;
    for block in blocks {
        let object = block.as_object()?;
        match block["type"].as_str() {
            Some("text") if object.len() == 2 && object.get("text")?.is_string() => {}
            Some("tool_reference") if tool_reference_name(block).is_some() => {}
            _ => return None,
        }
    }
    Some(value.clone())
}

/// 历史公告的合并状态：已公告集合、曾完整列名集合。
pub fn announcement_delta(messages: &[Value]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut announced = BTreeSet::new();
    let mut listed = BTreeSet::new();
    for message in messages {
        let Some(delta) = message
            .get(ANNOUNCEMENT_KEY)
            .and_then(Announcement::from_value)
        else {
            continue;
        };
        let readded: BTreeSet<&String> = delta.readded_names.iter().collect();
        for name in &delta.added_names {
            announced.insert(name.clone());
            if !readded.contains(name) {
                listed.insert(name.clone());
            }
        }
        for name in &delta.removed_names {
            announced.remove(name);
        }
    }
    (announced, listed)
}

/// `DeferredToolCall` 的严格入参（Node `DeferredToolCallInputSchema`）。
pub fn deferred_input(args: &Value) -> Option<(String, Value)> {
    let object = args.as_object()?;
    if object.len() != 2 {
        return None;
    }
    let name = args.get("name")?.as_str().filter(|n| !n.is_empty())?;
    let input = args.get("input")?;
    input.as_object()?;
    Some((name.to_owned(), input.clone()))
}

/// 从模型调用里识别可解包的 `DeferredToolCall`（只在 Local 请求接受）。
pub fn wrapper_target(call: &Value) -> Option<(String, Value)> {
    if call["function"]["name"].as_str() != Some(DEFERRED_TOOL_CALL_NAME) {
        return None;
    }
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str()?).ok()?;
    deferred_input(&args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovered_only_from_successful_search_results() {
        let messages = vec![
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}},
                {"id":"c2","type":"function","function":{"name":"WebFetch","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":[
                {"type":"text","text":"found"},
                {"type":"tool_reference","toolName":"TodoWrite"}]}),
            // 任意成功工具结果里的真实引用都计入（Node 不按调用名过滤）。
            json!({"role":"tool","tool_call_id":"c2","content":[
                {"type":"tool_reference","toolName":"WebFetch","extra":1}]}),
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c3","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"c3","content":[
                {"type":"tool_reference","toolName":"Failed"}],"_zcode_tool_failed":true}),
        ];
        let discovered = collect_discovered(&messages, &["Kept".into()]);
        assert_eq!(
            discovered.into_iter().collect::<Vec<_>>(),
            vec![
                "Kept".to_owned(),
                "TodoWrite".to_owned(),
                "WebFetch".to_owned()
            ]
        );
    }

    #[test]
    fn model_content_is_strict() {
        assert!(model_content(&json!([])).is_none());
        assert!(model_content(&json!("text")).is_none());
        assert!(model_content(&json!([{"type":"text"}])).is_none());
        assert!(model_content(&json!([{"type":"text","text":"a","extra":1}])).is_none());
        assert!(model_content(&json!([{"type":"tool_reference","toolName":""}])).is_none());
        assert!(model_content(&json!([{"type":"tool_reference","toolName":"A"}])).is_some());
        assert!(
            model_content(&json!([{"type":"text","text":"a"},
                {"type":"tool_reference","toolName":"A"}]))
            .is_some()
        );
    }

    #[test]
    fn announcement_merges_and_validates() {
        let messages = vec![
            json!({ANNOUNCEMENT_KEY: {"addedNames":["B","A"],"removedNames":[],"readdedNames":["B"]}}),
            json!({ANNOUNCEMENT_KEY: {"addedNames":["C"],"removedNames":["A"],"readdedNames":[]}}),
            // 非法：readded 不在 added 中
            json!({ANNOUNCEMENT_KEY: {"addedNames":[],"removedNames":[],"readdedNames":["X"]}}),
        ];
        let (announced, listed) = announcement_delta(&messages);
        assert_eq!(
            announced.into_iter().collect::<Vec<_>>(),
            vec!["B".to_owned(), "C".to_owned()]
        );
        // A 曾被完整列名，第二条公告移除 A 后仍保留在「曾列名」集合。
        assert_eq!(
            listed.into_iter().collect::<Vec<_>>(),
            vec!["A".to_owned(), "C".to_owned()]
        );
        let delta = Announcement::from_value(
            &json!({"addedNames":["b","a"],"removedNames":[],"readdedNames":[]}),
        )
        .unwrap();
        assert_eq!(delta.added_names, vec!["a", "b"]);
        assert!(Announcement::from_value(&json!({"addedNames":["a"]})).is_none());
    }

    #[test]
    fn deferred_call_input_is_strict() {
        assert_eq!(
            deferred_input(&json!({"name":"TodoWrite","input":{"todos":[]}})),
            Some(("TodoWrite".into(), json!({"todos":[]})))
        );
        assert!(deferred_input(&json!({"name":"TodoWrite"})).is_none());
        assert!(deferred_input(&json!({"name":"","input":{}})).is_none());
        assert!(deferred_input(&json!({"name":"A","input":[],"x":1})).is_none());
        let call = json!({"id":"c","type":"function","function":{
            "name":"DeferredToolCall","arguments":"{\"name\":\"TodoWrite\",\"input\":{}}"}});
        assert_eq!(wrapper_target(&call), Some(("TodoWrite".into(), json!({}))));
        let direct =
            json!({"id":"c","type":"function","function":{"name":"TodoWrite","arguments":"{}"}});
        assert!(wrapper_target(&direct).is_none());
    }
}
