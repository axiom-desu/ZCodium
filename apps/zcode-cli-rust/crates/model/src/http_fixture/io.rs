//! `http_fixture` 的字节级 HTTP 读写：请求完整读取、严格长度解析、
//! accept backlog 清理与脚本化响应写出。
//!
//! 作为 `http_fixture` 的子模块，可直接访问父模块 `Response` 的私有字段，
//! 从而在拆文件保持各自 <400 行的同时不放宽响应字段可见性。
use super::Response;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 请求头大小上限；超过即视为测试请求构造错误。
const MAX_HEAD: usize = 1 << 20;
/// 请求体大小上限，避免畸形 `Content-Length` 触发无界分配。
const MAX_BODY: usize = 1 << 20;

/// 读到 `\r\n\r\n` 请求头边界，再按 `Content-Length` 读完请求体；
/// 返回 `false` 表示连接在完整请求到达前关闭，不应计数。
pub(super) async fn read_request(socket: &mut TcpStream) -> std::io::Result<bool> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        if buffer.len() > MAX_HEAD {
            return Err(invalid("request head exceeds cap"));
        }
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Ok(false);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    if head_end > MAX_HEAD {
        return Err(invalid("request head exceeds cap"));
    }
    let head_text = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let content_length = parse_content_length(&head_text)?;
    while buffer.len() < head_end + content_length {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Ok(false);
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(true)
}

/// 严格解析 `Content-Length`：存在即必须是合法非负十进制且在 cap 内；
/// 非法或重复值直接失败，不能默认成 0（reviewer：invalid 默认 0 会掩盖
/// 请求构造错误并让 fixture 对不完整 body 提前回响应）。
fn parse_content_length(head: &str) -> std::io::Result<usize> {
    let mut declared: Option<usize> = None;
    for line in head.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let raw = value.trim();
        let parsed = raw
            .parse::<usize>()
            .map_err(|_| invalid(format!("invalid Content-Length: {raw:?}")))?;
        if parsed > MAX_BODY {
            return Err(invalid(format!("Content-Length {parsed} exceeds cap")));
        }
        if declared.replace(parsed).is_some() {
            return Err(invalid("duplicate Content-Length"));
        }
    }
    Ok(declared.unwrap_or(0))
}

fn invalid(message: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_string())
}

/// 非阻塞清空 accept backlog：`finish` 时把“已连接但未读完请求”的迟到
/// attempt 计入 `accepted`，避免直接 abort handler 造成 under-count。
pub(super) async fn drain_accepts(listener: &TcpListener, accepted: &AtomicUsize) {
    while let Ok(Ok((socket, _))) = tokio::time::timeout(Duration::ZERO, listener.accept()).await {
        accepted.fetch_add(1, Ordering::SeqCst);
        drop(socket);
    }
}

fn head(response: &Response, chunked: bool) -> Vec<u8> {
    let framing = if chunked {
        "Transfer-Encoding: chunked\r\n".to_owned()
    } else {
        format!("Content-Length: {}\r\n", response.body.len())
    };
    let mut head = format!("HTTP/1.1 {} Fixture\r\n{framing}", response.status);
    for (name, value) in &response.headers {
        if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    head.into_bytes()
}

pub(super) async fn write_full(socket: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    socket.write_all(&head(response, false)).await?;
    socket.write_all(&response.body).await?;
    socket.flush().await
}

pub(super) async fn write_chunked(
    socket: &mut TcpStream,
    response: &Response,
) -> std::io::Result<()> {
    socket.write_all(&head(response, true)).await?;
    socket
        .write_all(format!("{:X}\r\n", response.body.len()).as_bytes())
        .await?;
    socket.write_all(&response.body).await?;
    socket.write_all(b"\r\n").await?;
    socket.flush().await
}

#[cfg(test)]
mod tests {
    use super::{MAX_BODY, parse_content_length};

    #[test]
    fn content_length_is_parsed_strictly_and_capped() {
        let ok = "POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n";
        assert_eq!(parse_content_length(ok).unwrap(), 5);
        // 缺失视为无 body；不把缺失与非法混为一谈。
        assert_eq!(parse_content_length("GET / HTTP/1.1\r\n\r\n").unwrap(), 0);
        assert!(parse_content_length("POST / HTTP/1.1\r\nContent-Length: nope\r\n\r\n").is_err());
        assert!(parse_content_length("POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n").is_err());
        assert!(
            parse_content_length(
                "POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n"
            )
            .is_err()
        );
        let over = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(parse_content_length(&over).is_err());
    }
}
