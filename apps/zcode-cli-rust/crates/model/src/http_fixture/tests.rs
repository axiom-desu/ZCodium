use super::*;
use futures_util::FutureExt;
use tokio::net::TcpStream;

/// channel 提前关闭必须立即失败，不能把 `recv()` 正常结束当成事件命中。
#[tokio::test]
async fn wait_for_event_fails_immediately_when_the_channel_closes() {
    let deadline = Bounded::new();
    let (tx, mut events) = mpsc::channel::<RunEvent>(1);
    drop(tx);
    let started = Instant::now();
    let outcome = std::panic::AssertUnwindSafe(wait_for_event(
        &deadline,
        &mut events,
        "an event that never arrives",
        |_| true,
    ))
    .catch_unwind()
    .await;
    assert!(outcome.is_err(), "closed channel must fail the wait");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "closed channel must fail immediately, waited {:?}",
        started.elapsed()
    );
}

/// 正常请求完成后、`finish` 前出现的迟到连接必须计入 accepted；
/// `finish` 先 drain backlog，而不是直接 abort 造成 under-count。
#[tokio::test]
async fn late_connection_before_finish_is_counted_as_accepted() {
    let fixture = Fixture::start(|_| Reply::Close(Response::sse("data: [DONE]\n\n"))).await;
    let deadline = Bounded::new();
    let _probe = TcpStream::connect(fixture.addr())
        .await
        .expect("late probe connect");
    // 连接已建立但未发送请求：accepted=1、complete=0。
    let stats = fixture.finish(&deadline).await;
    assert_eq!(stats.accepted, 1, "late connection must be accepted");
    assert_eq!(stats.complete, 0, "late connection has no complete request");
}
