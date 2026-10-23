//! Loopback HTTP fixture for the real-engine ToolSearch E2E tests.
//! Only loopback, no credentials, no external network.
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

pub struct Fixture {
    pub addr: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<Value>>>,
    script: Arc<Mutex<VecDeque<String>>>,
    cancel: CancellationToken,
}

impl Fixture {
    pub async fn start(script: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let script: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(script.into()));
        let cancel = CancellationToken::new();
        tokio::spawn({
            let requests = requests.clone();
            let script = script.clone();
            let cancel = cancel.clone();
            async move {
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        accepted = listener.accept() => {
                            let Ok((mut socket, _)) = accepted else { continue };
                            let requests = requests.clone();
                            let script = script.clone();
                            tokio::spawn(async move {
                                let Some(body) = read_request(&mut socket).await else { return };
                                let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                                requests.lock().unwrap().push(value);
                                let reply = script
                                    .lock()
                                    .unwrap()
                                    .pop_front()
                                    .unwrap_or_else(final_text);
                                if reply == HOLD {
                                    // 模拟供应商不返回 headers：取消必须由 stop 打断。
                                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                                    return;
                                }
                                let _ = write_sse(&mut socket, &reply).await;
                            });
                        }
                    }
                }
            }
        });
        Self {
            addr,
            requests,
            script,
            cancel,
        }
    }

    pub fn bodies(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }

    pub fn push(&self, response: String) {
        self.script.lock().unwrap().push_back(response);
    }

    pub fn requests(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn read_request(socket: &mut TcpStream) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while buffer.len() < head_end + length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(buffer[head_end..head_end + length].to_vec())
}

async fn write_sse(socket: &mut TcpStream, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body.as_bytes()).await?;
    socket.flush().await
}

pub fn event(value: Value) -> String {
    format!("data: {value}\n\n")
}

pub fn text_reply(text: &str) -> String {
    [
        event(json!({"type":"message_start","message":{"usage":{"input_tokens":1}}})),
        event(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
        event(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}})),
        event(json!({"type":"content_block_stop","index":0})),
        event(json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}})),
        event(json!({"type":"message_stop"})),
    ]
    .concat()
}

pub fn tool_reply(id: &str, name: &str, input: Value) -> String {
    [
        event(json!({"type":"message_start","message":{"usage":{"input_tokens":1}}})),
        event(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}})),
        event(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}})),
        event(json!({"type":"content_block_stop","index":0})),
        event(json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}})),
        event(json!({"type":"message_stop"})),
    ]
    .concat()
}

/// Anthropic tools in the request, as `(name, defer_loading)`.
pub fn tools(body: &Value) -> Vec<(String, bool)> {
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| {
            (
                tool["name"].as_str().unwrap_or("").to_owned(),
                tool["defer_loading"] == true,
            )
        })
        .collect()
}

pub const HOLD: &str = "__hold__";

pub fn hold() -> String {
    HOLD.into()
}

pub fn final_text() -> String {
    text_reply("Done.")
}
