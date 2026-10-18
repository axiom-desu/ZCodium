use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

pub(crate) fn prompt(interaction: &Value) -> String {
    let payload = &interaction["payload"];
    if interaction["kind"] == "permission" {
        let choices = payload["options"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|o| {
                format!(
                    "{}: {}",
                    o["optionId"].as_str().unwrap_or("?"),
                    o["label"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        return format!(
            "{} {} · {choices} · y/n",
            payload["toolName"].as_str().unwrap_or("Tool"),
            payload["summary"].as_str().unwrap_or("")
        );
    }
    if let Some(questions) = payload["input"]["questions"].as_array() {
        return questions
            .iter()
            .map(|q| {
                format!(
                    "{} [{}]",
                    q["question"].as_str().unwrap_or(""),
                    q["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|o| o["label"].as_str())
                        .collect::<Vec<_>>()
                        .join(" / ")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
    }
    format!(
        "{} · y/n",
        payload["summary"].as_str().unwrap_or("Approval")
    )
}

pub(crate) fn panel(interaction: &Value, zh: bool) -> String {
    let clip = |v: &Value| {
        v.as_str()
            .unwrap_or("")
            .chars()
            .take(1024)
            .collect::<String>()
    };
    let p = &interaction["payload"];
    let mut lines = Vec::new();
    if interaction["kind"] == "permission" {
        lines.push(format!(
            "{} · {}",
            clip(&p["toolName"]),
            clip(&p["summary"])
        ));
        for option in p["options"].as_array().into_iter().flatten().take(16) {
            lines.push(format!(
                "{}: {}",
                clip(&option["optionId"]),
                clip(&option["label"])
            ));
        }
        lines.push(
            if zh {
                "输入 y/n 或明确的选项 ID；空 Enter 不会批准"
            } else {
                "Type y/n or an offered option ID; empty Enter never approves"
            }
            .into(),
        );
    } else if let Some(questions) = p["input"]["questions"].as_array() {
        for q in questions.iter().take(8) {
            lines.push(clip(&q["question"]));
            for option in q["options"].as_array().into_iter().flatten().take(12) {
                lines.push(format!("  • {}", clip(&option["label"])));
            }
        }
        lines.push(
            if zh {
                "每个问题输入一行答案；多问题可多行粘贴"
            } else {
                "One answer per question; paste multiple lines"
            }
            .into(),
        );
    } else {
        lines.push(prompt(interaction));
    }
    lines.join("\n")
}

pub(crate) fn answer(interaction: &Value, text: &str) -> Result<Value> {
    if interaction["kind"] == "permission" {
        let options = interaction["payload"]["options"]
            .as_array()
            .context("No permission options")?;
        let requested = match text.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => "allowOnce",
            "n" | "no" => "deny",
            _ => text.trim(),
        };
        let option = options
            .iter()
            .find(|o| o["optionId"] == requested)
            .context("Enter y/n or an offered optionId")?;
        return Ok(json!({"optionId":option["optionId"]}));
    }
    let questions = interaction["payload"]["input"]["questions"].as_array();
    if let Some(questions) = questions {
        let values: Vec<_> = text.lines().collect();
        // 空 Enter 不代表用户完成了问答，不能将空串当作一次明确批准。
        if values.len() != questions.len() || values.iter().any(|v| v.trim().is_empty()) {
            bail!("Provide one answer per question (paste multiple lines)");
        }
        let mut answers = serde_json::Map::new();
        for (question, value) in questions.iter().zip(values) {
            answers.insert(
                question["question"]
                    .as_str()
                    .context("Invalid question")?
                    .into(),
                value.into(),
            );
        }
        return Ok(json!({"action":"accept","content":{"answers":answers}}));
    }
    match text.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok(json!({"action":"accept"})),
        "n" | "no" => Ok(json!({"action":"decline"})),
        _ => bail!("Enter yes/y or no/n"),
    }
}
