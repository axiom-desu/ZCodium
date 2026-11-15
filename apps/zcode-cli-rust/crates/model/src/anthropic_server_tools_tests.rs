//! 上游 3.18.2 F11（Rust 侧）：Anthropic provider 原生工具块的线协议归一化与历史回放。
//! 语义见 `.agents/specs/upstream-3.18-rust-context.md`。
use crate::config::ModelConfig;
use crate::contract::EventSink;
use crate::model_protocol::{ApiType, ProtocolStream, body};
use crate::model_stream::TextBuffer;
use serde_json::{Value, json};

fn config(api_type: ApiType) -> ModelConfig {
    let mut config: ModelConfig = serde_json::from_value(json!({
        "providerId": "fixture",
        "modelId": "fixture",
        "reasoningLevel": "none",
        "baseUrl": "https://example.invalid",
    }))
    .unwrap();
    config.api_type = api_type;
    config
}

fn sink() -> (
    tokio::sync::mpsc::Receiver<crate::contract::RunEvent>,
    EventSink,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let sink = EventSink {
        session_id: "s".into(),
        run_id: "r".into(),
        tx,
        origin: crate::contract::RequestOrigin::detached("t".into()),
        request_auth: None,
    };
    (rx, sink)
}

fn frames() -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"**🌐 looking**"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"s1","name":"webReader","input":{}}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"url\":\"x\"}"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"web_fetch_tool_result","tool_use_id":"s1","content":[{"type":"text","text":"ok"}]}}),
        json!({"type":"content_block_stop","index":2}),
        // 没有配对调用的结果块：回放会被 provider 拒绝，必须丢弃。
        json!({"type":"content_block_start","index":3,"content_block":{"type":"mcp_tool_result","tool_use_id":"missing","content":[]}}),
        json!({"type":"content_block_stop","index":3}),
        json!({"type":"content_block_start","index":4,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"**Output:** ok"}}),
        json!({"type":"content_block_stop","index":4}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
        json!({"type":"message_stop"}),
    ]
}

async fn consume_server_tools() -> Value {
    let (rx, sink) = sink();
    let mut output = TextBuffer::new(&sink);
    let mut stream = ProtocolStream::new(ApiType::Anthropic, true);
    for frame in frames() {
        stream
            .consume(&frame.to_string(), &mut output)
            .await
            .expect("provider native blocks are accepted");
    }
    let message = stream.finish().unwrap().message;
    drop(rx);
    message
}

#[tokio::test]
async fn provider_native_blocks_are_kept_and_normalized_instead_of_dropped() {
    let message = consume_server_tools().await;
    let text = message["content"].as_str().unwrap();
    // 调用头副本紧跟在服务端调用之前，按前缀确认后丢弃；不带工具名标签的
    // `**Output:** ok` 确认不了是摘要副本，必须原样保留，不能误删模型正文。
    assert!(
        !text.contains("**🌐 looking**"),
        "rendered call copy is dropped"
    );
    assert_eq!(text, "**Output:** ok");
    let blocks = message["_zcode_anthropic_server_tools"]
        .as_array()
        .expect("server tool blocks preserved");
    assert_eq!(blocks.len(), 2, "the unpaired result is dropped");
    assert_eq!(blocks[0]["type"], "server_tool_use");
    assert_eq!(blocks[0]["id"], "s1");
    assert_eq!(blocks[0]["name"], "webReader");
    assert_eq!(
        blocks[0]["input"],
        json!({"url": "x"}),
        "streamed input_json_delta is merged into the replayed call"
    );
    assert_eq!(blocks[1]["type"], "web_fetch_tool_result");
    assert_eq!(blocks[1]["tool_use_id"], "s1");
}

#[tokio::test]
async fn a_native_mcp_call_gets_the_server_name_the_schema_requires() {
    let (rx, sink) = sink();
    let mut output = TextBuffer::new(&sink);
    let mut stream = ProtocolStream::new(ApiType::Anthropic, true);
    for frame in [
        json!({"type":"message_start","message":{"usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"mcp_tool_use","id":"m1","name":"analyze_image","input":{"image":"a"}}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"mcp_tool_result","tool_use_id":"m1","is_error":false,"content":[{"type":"text","text":"cat"}]}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ] {
        stream
            .consume(&frame.to_string(), &mut output)
            .await
            .unwrap();
    }
    let message = stream.finish().unwrap().message;
    drop(rx);
    let blocks = message["_zcode_anthropic_server_tools"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["server_name"], "zcode-provider-builtin");
    assert_eq!(blocks[0]["input"], json!({"image": "a"}));
    assert_eq!(blocks[1]["type"], "mcp_tool_result");
}

#[tokio::test]
async fn the_next_request_replays_the_preserved_blocks_in_arrival_order() {
    let message = consume_server_tools().await;
    let messages = vec![
        json!({"role":"system","content":"be brief"}),
        json!({"role":"user","content":"read that page"}),
        json!({"role":"assistant","content": message["content"],
            "_zcode_anthropic_server_rounds": message["_zcode_anthropic_server_rounds"]}),
        json!({"role":"user","content":"and now summarize"}),
        json!({"role":"assistant","content":"summary"}),
    ];
    let anthropic = body(
        &config(ApiType::Anthropic),
        messages.clone(),
        &[],
        None,
        false,
    )
    .unwrap();
    // 3.18 R2：调用与结果必须拆成 assistant(tool_use) + user(tool_result)；
    // Anthropic 不接受助手消息里的结果块，也不能把多轮正文拼进一条助手消息。
    let round = &anthropic["messages"][1];
    assert_eq!(round["role"], "assistant");
    let content = round["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "server_tool_use");
    assert_eq!(content[0]["id"], "s1");
    assert_eq!(content[0]["input"], json!({"url": "x"}));
    let result = &anthropic["messages"][2];
    assert_eq!(result["role"], "user");
    assert_eq!(result["content"][0]["type"], "web_fetch_tool_result");
    assert_eq!(result["content"][0]["tool_use_id"], "s1");
    // 尾部正文仍是一条单独的助手消息。
    assert_eq!(anthropic["messages"][3]["role"], "assistant");
    assert_eq!(
        anthropic["messages"][3]["content"][0]["text"],
        "**Output:** ok"
    );

    // 其他协议不回放 provider 原生块。
    for api in [ApiType::Chat, ApiType::Responses] {
        let encoded = body(&config(api), messages.clone(), &[], None, false).unwrap();
        assert!(
            !encoded.to_string().contains("web_fetch_tool_result"),
            "provider native blocks stay on the Anthropic wire"
        );
    }
}

#[tokio::test]
async fn rendered_summary_copies_are_dropped_only_when_the_tool_label_matches() {
    async fn run(summary: &str) -> (String, Value) {
        let (rx, sink) = sink();
        let mut output = TextBuffer::new(&sink);
        let mut stream = ProtocolStream::new(ApiType::Anthropic, true);
        for frame in [
            json!({"type":"message_start","message":{"usage":{"input_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"**🌐 looking**"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"mcp_tool_use","id":"m1","name":"analyze_image","input":{}}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"mcp_tool_result","tool_use_id":"m1","content":[{"type":"text","text":"cat"}]}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":summary}}),
            json!({"type":"content_block_stop","index":3}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
            json!({"type":"message_stop"}),
        ] {
            stream
                .consume(&frame.to_string(), &mut output)
                .await
                .unwrap();
        }
        let message = stream.finish().unwrap().message;
        drop(rx);
        let text = message["content"].as_str().unwrap_or("").to_owned();
        (text, message)
    }
    let (text, message) = run("**Output:**\n**analyze_image_result_summary:** a cat").await;
    assert_eq!(text, "", "the rendered summary copy is dropped");
    let rounds = message["_zcode_anthropic_server_rounds"]
        .as_array()
        .unwrap();
    assert_eq!(rounds.len(), 1, "a trailing empty segment is not stored");
    assert_eq!(rounds[0]["call"]["name"], "analyze_image");

    let (text, _) = run("**Output:** something the model wrote itself").await;
    assert_eq!(
        text, "**Output:** something the model wrote itself",
        "an unconfirmed summary must stay in the model text"
    );
}

#[tokio::test]
async fn a_server_block_of_a_previous_model_is_not_replayed() {
    let mut assistant = json!({"role":"assistant","content":"x","_zcode_anthropic_server_tools":[
        {"type":"server_tool_use","id":"s1","name":"webReader","input":{}}
    ], "_zcode_anthropic_server_rounds":[{
        "thinking":[], "text":"x",
        "call":{"type":"server_tool_use","id":"s1","name":"webReader","input":{}},
        "result":{"type":"web_fetch_tool_result","tool_use_id":"s1","content":[]}
    }]});
    assistant["_zcode_origin"] = json!({"provider": "other", "model": "elsewhere"});
    let messages = vec![
        json!({"role":"user","content":"q"}),
        assistant,
        json!({"role":"user","content":"next"}),
    ];
    let encoded = body(&config(ApiType::Anthropic), messages, &[], None, false).unwrap();
    assert!(!encoded.to_string().contains("server_tool_use"));
    assert!(!encoded.to_string().contains("web_fetch_tool_result"));
}
