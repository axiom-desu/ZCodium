//! 等待 owner 事务落盘的统一入口（提醒、公告、工具结果都走同一 receipt）。
use anyhow::{Context, Result, bail};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) async fn durable(
    receipt: oneshot::Receiver<()>,
    cancel: &CancellationToken,
) -> Result<()> {
    tokio::select! {biased;
        _=cancel.cancelled()=>bail!("Cancelled"),
        result=receipt=>result.context("Session owner stopped before durable commit"),
    }
}
