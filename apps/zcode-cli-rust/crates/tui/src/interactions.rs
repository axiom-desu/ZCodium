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
        if values.len() != questions.len() {
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
