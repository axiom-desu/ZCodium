// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::Sink;
use crate::domain::MAX_REQUEST_BYTES;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::io::BufRead;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_protocol::Request;

pub use crate::contract::Input;

/// Start stdin framing: one NDJSON message per line, bounded by `MAX_REQUEST_BYTES`.
pub fn start(input_closed: CancellationToken) -> mpsc::Receiver<Input> {
    let (in_tx, in_rx) = mpsc::channel(64);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        read_frames(stdin.lock(), &in_tx);
        input_closed.cancel();
        let _ = in_tx.blocking_send(Input::Eof);
    });
    in_rx
}
fn read_frames<R: BufRead>(mut reader: R, tx: &mpsc::Sender<Input>) {
    let mut line = Vec::new();
    while let Ok(available) = reader.fill_buf() {
        if available.is_empty() {
            if !line.is_empty() {
                dispatch(tx, &line);
            }
            break;
        }
        let take = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |i| i + 1);
        if line.len() + take > MAX_REQUEST_BYTES {
            let _ = tx.blocking_send(Input::TooLarge);
            break;
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if line.last() == Some(&b'\n') {
            if !dispatch(tx, &line) {
                return;
            }
            line.clear();
        }
    }
}

fn dispatch(tx: &mpsc::Sender<Input>, line: &[u8]) -> bool {
    if line.iter().all(u8::is_ascii_whitespace) {
        return true;
    }
    let value = match serde_json::from_slice::<Value>(line) {
        Ok(v) => v,
        Err(_) => return tx.blocking_send(Input::Invalid).is_ok(),
    };
    if value.get("method").is_none()
        && let Some(id) = value["id"].as_str()
        && (value.get("result").is_some() ^ value.get("error").is_some())
    {
        return tx
            .blocking_send(Input::Response {
                id: id.into(),
                result: value.get("result").cloned().unwrap_or(Value::Null),
            })
            .is_ok();
    }
    if value["method"] == "startup/storagePathReady" {
        // 共享 schema `zcodeStoragePathReadySchema` 是顶层 `{method, reuse?}`：
        // 非法 reuse 或额外字段不能被当成缺省 false 放行开库。
        let request = match storage_path_ready(&value) {
            Some(reuse) => Input::Request(Request {
                id: None,
                method: "startup/storagePathReady".into(),
                params: json!({ "reuse": reuse }),
                trace: None,
            }),
            None => Input::Invalid,
        };
        return tx.blocking_send(request).is_ok();
    }
    let request = serde_json::from_value::<Request>(value);
    tx.blocking_send(match request {
        Ok(r) if !r.method.trim().is_empty() => Input::Request(r),
        _ => Input::Invalid,
    })
    .is_ok()
}

/// 严格解析 Host 握手：只接受顶层 `method` 与可选布尔 `reuse`，缺省表示 false。
fn storage_path_ready(value: &Value) -> Option<bool> {
    let object = value.as_object()?;
    if object.keys().any(|key| key != "method" && key != "reuse") {
        return None;
    }
    match object.get("reuse") {
        None => Some(false),
        Some(Value::Bool(reuse)) => Some(*reuse),
        Some(_) => None,
    }
}

pub async fn finish(writer: std::thread::JoinHandle<()>) -> Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    while !writer.is_finished() {
        if tokio::time::Instant::now() >= deadline {
            bail!("Protocol output drain timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("Protocol writer failed"))
}

/// Handshake failure carrying Node's existing `DatabaseStartupErrorCode`, so the
/// `--prepare-storage` path can report a valid failed frame for timeout/EOF.
#[derive(Debug)]
pub struct StorageHandshakeError {
    pub code: &'static str,
    pub message: &'static str,
}

impl std::fmt::Display for StorageHandshakeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for StorageHandshakeError {}

/// Sends `startup/storagePath`, then waits once for the strict
/// `startup/storagePathReady` ack; returns whether Host granted `reuse`.
pub async fn storage_prepare(
    path: &std::path::Path,
    input: &mut mpsc::Receiver<Input>,
    output: &mut Sink,
) -> Result<bool> {
    output
        .send_values(vec![
            json!({"method":"startup/storagePath","params":{"path":path}}),
        ])
        .await?;
    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), input.recv())
        .await
        .map_err(|_| StorageHandshakeError {
            code: "startup_status_timeout",
            message: "Storage observation handshake timed out",
        })?;
    match frame {
        // `dispatch` 已按共享 schema 归一化为 `{ "reuse": bool }`。
        Some(Input::Request(request)) if request.method == "startup/storagePathReady" => {
            Ok(request
                .params
                .get("reuse")
                .and_then(Value::as_bool)
                .unwrap_or(false))
        }
        Some(Input::Eof) | None => Err(StorageHandshakeError {
            code: "transport_closed",
            message: "Storage preparation input closed",
        }
        .into()),
        _ => Err(StorageHandshakeError {
            code: "sql_failed",
            message: "Storage preparation handshake failed",
        }
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn fragmented_multiframe_input_keeps_bad_frames_isolated_and_dispatches_eof_tail() {
        let (tx, mut rx) = mpsc::channel(8);
        let bytes = b"  \nnot-json\n{\"method\":\"one\",\"id\":1}\n{\"method\":\"tail\"}";
        read_frames(BufReader::with_capacity(2, Cursor::new(bytes)), &tx);
        assert!(matches!(rx.try_recv(), Ok(Input::Invalid)));
        assert!(
            matches!(rx.try_recv(), Ok(Input::Request(r)) if r.method == "one" && r.id == Some(zcode_cli_protocol::RequestId::Number(1)))
        );
        assert!(
            matches!(rx.try_recv(), Ok(Input::Request(r)) if r.method == "tail" && r.id.is_none())
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn request_size_boundary_is_inclusive_and_oversize_fails_closed() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut exact = b"{\"method\":\"x\"}".to_vec();
        exact.resize(MAX_REQUEST_BYTES - 1, b' ');
        exact.push(b'\n');
        read_frames(Cursor::new(exact), &tx);
        assert!(matches!(rx.try_recv(), Ok(Input::Request(r)) if r.method == "x"));

        let (tx, mut rx) = mpsc::channel(4);
        let mut over = b"{\"method\":\"x\"}".to_vec();
        over.resize(MAX_REQUEST_BYTES, b' ');
        over.push(b'\n');
        read_frames(Cursor::new(over), &tx);
        assert!(matches!(rx.try_recv(), Ok(Input::TooLarge)));
    }
}
