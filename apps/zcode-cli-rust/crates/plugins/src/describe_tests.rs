//! Read-lane regressions of `describe` (upstream 3.16.2: cached marketplace
//! describe must not queue behind an install's storage lock, while the lazy
//! manifest write stays inside that same lock with a second check).
use crate::git::Git;
use crate::http::{Get, Http, Response};
use crate::ports::Ports;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// 只在测试里当“卡死探测器”：真正的同步屏障是持锁 guard 与 latch。
const DETECT: Duration = Duration::from_secs(10);
/// 反向断言（必须仍未完成）的观察窗口；被断言的完成路径是毫秒级 fs 操作。
const PENDING_WINDOW: Duration = Duration::from_secs(1);

struct Fixture {
    http: Counting,
    storage: PathBuf,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new(body: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        Self {
            http: Counting {
                body: body.unwrap_or_default().to_owned(),
                requests: Arc::new(AtomicUsize::new(0)),
            },
            storage: dir.path().join("plugins"),
            _dir: dir,
        }
    }

    async fn plugin_dir(&self) -> PathBuf {
        let root = self.storage.parent().unwrap().join("plugin");
        tokio::fs::create_dir_all(root.join(".zcodium-plugin"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(root.join("skills/marker"))
            .await
            .unwrap();
        tokio::fs::write(
            root.join(".zcodium-plugin/plugin.json"),
            r#"{"name":"local","version":"1.0.0"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            root.join("skills/marker/SKILL.md"),
            "---\nname: marker\ndescription: Marker\n---\n",
        )
        .await
        .unwrap();
        root
    }

    async fn write_marketplace(&self, id: &str, manifest: &serde_json::Value) {
        let dir = crate::store::market_dir(&self.storage, id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("marketplace.json"),
            serde_json::to_string(manifest).unwrap(),
        )
        .await
        .unwrap();
    }

    async fn write_known(&self, record: serde_json::Value) {
        tokio::fs::create_dir_all(&self.storage).await.unwrap();
        let body = serde_json::json!({"version":1,"marketplaces":[record]});
        tokio::fs::write(
            self.storage.join("known_marketplaces.json"),
            serde_json::to_string(&body).unwrap(),
        )
        .await
        .unwrap();
    }
}

/// 只服务一份市场 JSON；第二次抓取直接失败，用来证明锁内二次检查生效。
struct Counting {
    body: String,
    requests: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl Http for Counting {
    async fn get(&self, _: Get<'_>, _: &CancellationToken) -> Result<Response> {
        let attempt = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt > 1 {
            anyhow::bail!("unexpected second marketplace fetch");
        }
        Ok(Response {
            status: 200,
            status_text: "OK".into(),
            location: None,
            body: self.body.clone().into_bytes(),
        })
    }
}

fn describe_cached(plugin: &Path, marketplace: &str) -> serde_json::Value {
    serde_json::json!({"name":marketplace,"plugins":[
        {"name":"local","source":{"source":"directory","path":plugin}}]})
}

#[tokio::test]
async fn cached_marketplace_describe_does_not_wait_for_the_storage_lock() {
    let fixture = Fixture::new(None);
    let plugin = fixture.plugin_dir().await;
    fixture
        .write_marketplace("cached", &describe_cached(&plugin, "cached"))
        .await;
    let cancel = CancellationToken::new();
    let git = Git {
        binary: "git".into(),
        env: vec![],
    };
    let ports = Ports {
        storage: &fixture.storage,
        cancel: &cancel,
        http: &fixture.http,
        git: &git,
    };
    // 安装占锁：整个 describe 期间一直持有，不释放。
    let guard = crate::atomic_write::lock(&fixture.storage).await;
    let described = tokio::time::timeout(DETECT, super::describe(&ports, "cached", "local"))
        .await
        .expect("已缓存 manifest 的详情读取不能排在安装后面");
    drop(guard);
    assert!(
        described.diagnostics.is_empty(),
        "{:?}",
        described.diagnostics
    );
    assert_eq!(described.components.len(), 1);
    assert_eq!(described.components[0].items[0].0, "marker");
    assert_eq!(fixture.http.requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn missing_manifest_describe_fetches_once_under_the_lock() {
    let fixture = Fixture::new(None);
    let plugin = fixture.plugin_dir().await;
    let manifest = describe_cached(&plugin, "shared-market");
    let fixture = Fixture {
        http: Counting {
            body: serde_json::to_string(&manifest).unwrap(),
            requests: Arc::new(AtomicUsize::new(0)),
        },
        ..fixture
    };
    fixture
        .write_known(serde_json::json!({
            "id":"shared-market","name":"shared-market","pluginCount":1,
            "addedAt":"2026-01-01T00:00:00.000Z",
            "source":{"source":"url","url":"https://fixture.test/marketplace.json"}}))
        .await;
    let cancel = CancellationToken::new();
    let git = Git {
        binary: "git".into(),
        env: vec![],
    };
    let ports = Ports {
        storage: &fixture.storage,
        cancel: &cancel,
        http: &fixture.http,
        git: &git,
    };
    // 两个并发读者都先看到缺 manifest，只有进入锁的第一个抓取并写盘。
    let (first, second) = tokio::time::timeout(DETECT, async {
        tokio::join!(
            super::describe(&ports, "shared-market", "local"),
            super::describe(&ports, "shared-market", "local")
        )
    })
    .await
    .expect("并发 describe 必须在锁内二次检查后完成");
    assert_eq!(fixture.http.requests.load(Ordering::SeqCst), 1);
    assert!(first.diagnostics.is_empty(), "{:?}", first.diagnostics);
    assert!(second.diagnostics.is_empty(), "{:?}", second.diagnostics);
    assert_eq!(second.components[0].items[0].0, "marker");
}

#[tokio::test]
async fn describe_queues_when_the_marketplace_manifest_must_be_written() {
    let fixture = Fixture::new(None);
    let requests = Arc::clone(&fixture.http.requests);
    let storage = fixture.storage.clone();
    // 安装占锁期间，缺 manifest 的详情属于写路径：必须停在同一把锁上，不能先给出结果。
    let guard = crate::atomic_write::lock(&storage).await;
    let mut handle = tokio::spawn(async move {
        let cancel = CancellationToken::new();
        let git = Git {
            binary: "git".into(),
            env: vec![],
        };
        let ports = Ports {
            storage: &fixture.storage,
            cancel: &cancel,
            http: &fixture.http,
            git: &git,
        };
        let described = super::describe(&ports, "missing-market", "local").await;
        (described.components.len(), described.diagnostics[0].code)
    });
    assert!(
        tokio::time::timeout(PENDING_WINDOW, &mut handle)
            .await
            .is_err(),
        "缺 manifest 的详情不能绕开 storage lock"
    );
    drop(guard);
    let (components, code) = tokio::time::timeout(DETECT, handle)
        .await
        .expect("放锁后详情必须完成")
        .expect("describe task");
    assert_eq!(components, 0);
    assert_eq!(code, "plugin_marketplace_invalid");
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn describe_releases_the_lock_after_a_failed_fetch() {
    let fixture = Fixture::new(Some("not-json"));
    fixture
        .write_known(serde_json::json!({
            "id":"broken-market","name":"broken-market","pluginCount":1,
            "addedAt":"2026-01-01T00:00:00.000Z",
            "source":{"source":"url","url":"https://fixture.test/broken.json"}}))
        .await;
    let cancel = CancellationToken::new();
    let git = Git {
        binary: "git".into(),
        env: vec![],
    };
    let ports = Ports {
        storage: &fixture.storage,
        cancel: &cancel,
        http: &fixture.http,
        git: &git,
    };
    let failed = super::describe(&ports, "broken-market", "local").await;
    assert!(!failed.diagnostics.is_empty());
    // 失败不能让锁链挂死：后续写路径必须还能进入临界区。
    let guard = tokio::time::timeout(DETECT, crate::atomic_write::lock(&fixture.storage))
        .await
        .expect("失败的 describe 必须释放 storage lock");
    drop(guard);
    let plugin = fixture.plugin_dir().await;
    fixture
        .write_marketplace("cached", &describe_cached(&plugin, "cached"))
        .await;
    let cached = super::describe(&ports, "cached", "local").await;
    assert_eq!(cached.components[0].items[0].0, "marker");
}
