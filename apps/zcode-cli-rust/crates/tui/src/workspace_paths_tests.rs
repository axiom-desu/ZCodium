//! `@file` 路径查询的真实临时目录回归：token 边界、排序/上限、隐藏与 VCS 过滤、
//! symlink 穿出与显式错误。
use super::*;
use std::path::Path;

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::create_dir_all(root.join("models")).unwrap();
    std::fs::create_dir_all(root.join(".hidden-dir")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(root.join("xmain.rs"), "fn x() {}").unwrap();
    std::fs::write(root.join("alpha.md"), "# a").unwrap();
    std::fs::write(root.join(".hidden.md"), "h").unwrap();
    std::fs::write(root.join("hello"), "hello").unwrap();
    std::fs::write(root.join("src/lib.rs"), "pub fn a() {}").unwrap();
    dir
}

fn root_of(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

#[test]
fn tokens_reject_unsafe_paths_and_split_directory_query() {
    assert_eq!(parse("/etc/passwd"), None);
    assert_eq!(parse("\\share\\x"), None);
    assert_eq!(parse("C:\\Users\\x"), None);
    assert_eq!(parse("c:/x"), None);
    assert_eq!(parse("src/../secret"), None);
    assert_eq!(parse("src/\u{7}"), None);
    assert_eq!(
        parse("@src/ma"),
        Some(Parsed {
            directory: "src/".into(),
            query: "ma".into()
        })
    );
    // Windows 分隔符归一化后仍按 `/` 拆分。
    assert_eq!(
        parse("src\\ma"),
        Some(Parsed {
            directory: "src/".into(),
            query: "ma".into()
        })
    );
    assert_eq!(
        parse("@"),
        Some(Parsed {
            directory: String::new(),
            query: String::new()
        })
    );
}

#[tokio::test]
async fn directories_first_and_prefixes_before_substrings() {
    let dir = fixture();
    let (items, truncated) = query(&root_of(&dir), "@m", 50).await.unwrap();
    assert!(!truncated);
    let paths = items.iter().map(|e| e.path.as_str()).collect::<Vec<_>>();
    assert_eq!(paths, ["models/", "main.rs", "alpha.md", "xmain.rs"]);
}

#[tokio::test]
async fn hidden_dotfiles_and_version_control_are_filtered() {
    let dir = fixture();
    let (items, _) = query(&root_of(&dir), "@h", 50).await.unwrap();
    assert!(items.iter().all(|e| !e.path.starts_with('.')));
    let (items, _) = query(&root_of(&dir), "@.h", 50).await.unwrap();
    assert_eq!(items[0].path, ".hidden-dir/");
    assert!(items.iter().any(|e| e.path == ".hidden.md"));
    let (items, _) = query(&root_of(&dir), "@no", 50).await.unwrap();
    assert!(items.is_empty(), "node_modules must not be suggested");
    let (items, _) = query(&root_of(&dir), "@", 50).await.unwrap();
    let paths = items.iter().map(|e| e.path.as_str()).collect::<Vec<_>>();
    assert!(!paths.iter().any(|p| p.starts_with(".git")));
    assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
    assert!(paths.contains(&"src/"));
}

#[tokio::test]
async fn entries_carry_real_metadata_and_mime() {
    let dir = fixture();
    let (items, _) = query(&root_of(&dir), "@hello", 50).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].bytes, 5);
    assert_eq!(items[0].mime, "application/octet-stream");
    let (items, _) = query(&root_of(&dir), "@main", 50).await.unwrap();
    assert_eq!(items[0].bytes, "fn main() {}".len() as u64);
    assert_eq!(items[0].mime, "text/plain");
}

#[tokio::test]
async fn results_are_bounded_and_mark_truncation() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..60 {
        std::fs::write(dir.path().join(format!("f{index:02}.txt")), "x").unwrap();
    }
    let (items, truncated) = query(&root_of(&dir), "@f", 5).await.unwrap();
    assert_eq!(items.len(), 5);
    assert!(truncated);
    let (items, truncated) = query(&root_of(&dir), "@f", 50).await.unwrap();
    assert_eq!(items.len(), 50);
    assert!(truncated);
}

#[tokio::test]
async fn missing_directory_and_files_are_explicit_errors_or_empty() {
    let dir = fixture();
    assert!(query(&root_of(&dir), "@nope/x", 50).await.is_err());
    assert!(query(&root_of(&dir), "@../..", 50).await.is_err());
    let (items, _) = query(&root_of(&dir), "@src/nothing", 50).await.unwrap();
    assert!(items.is_empty());
    let missing = query("/definitely/not/here", "@", 50).await;
    assert!(missing.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_cannot_escape_the_workspace() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
    let dir = fixture();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        dir.path().join("escape.txt"),
    )
    .unwrap();
    // 目录 symlink 穿出：显式错误，不假成功返回空。
    let error = query(&root_of(&dir), "@linked/s", 50).await.unwrap_err();
    assert!(error.to_string().contains("escapes"), "{error}");
    // 根目录列举时穿出的 symlink 条目不进候选。
    let (items, _) = query(&root_of(&dir), "@e", 50).await.unwrap();
    assert!(items.iter().all(|e| e.path != "escape.txt"));
    let (items, _) = query(&root_of(&dir), "@l", 50).await.unwrap();
    assert!(items.iter().all(|e| e.path != "linked/"));
}

#[cfg(unix)]
#[tokio::test]
async fn control_character_names_never_become_candidates() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("bad\u{1}.txt"), "x").unwrap();
    std::fs::write(dir.path().join("good.txt"), "x").unwrap();
    let (items, _) = query(&root_of(&dir), "@", 50).await.unwrap();
    let paths = items.iter().map(|e| e.path.as_str()).collect::<Vec<_>>();
    assert_eq!(paths, ["good.txt"]);
    assert!(Path::new(&root_of(&dir)).join("good.txt").is_file());
}

#[tokio::test]
async fn excluded_directories_cannot_be_reached_through_the_token_prefix() {
    let dir = fixture();
    // TS 的目录排除只作用在被列举目录的条目名上；这里按下标/前缀一并拒绝，
    // 否则 `@node_modules/foo` 会绕过上面的过滤把依赖目录重新建议出来。
    for token in [
        "@node_modules/",
        "@node_modules/pkg",
        "@.git/",
        "@.git/objects",
        "@NODE_MODULES/pkg",
        "@src/node_modules/x",
    ] {
        let error = query(&root_of(&dir), token, 50)
            .await
            .expect_err("excluded directory prefix must be rejected");
        assert!(error.to_string().contains("xcluded"), "{token}: {error}");
    }
    // 正常的子目录前缀仍然工作。
    let (items, _) = query(&root_of(&dir), "@src/", 50).await.unwrap();
    assert_eq!(items[0].path, "src/lib.rs");
}

#[tokio::test]
async fn names_with_whitespace_are_never_suggested() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("has space.txt"), "x").unwrap();
    std::fs::write(dir.path().join("plain.txt"), "x").unwrap();
    let (items, _) = query(&root_of(&dir), "@has", 50).await.unwrap();
    assert!(items.is_empty(), "whitespace names cannot be @-mentioned");
    // `@` 后带空格不是 token：明确报错，不能假装“无匹配”成功。
    assert!(query(&root_of(&dir), "@ has", 50).await.is_err());
    let (items, _) = query(&root_of(&dir), "@", 50).await.unwrap();
    let paths = items.iter().map(|e| e.path.as_str()).collect::<Vec<_>>();
    assert_eq!(paths, ["plain.txt"]);
}

#[tokio::test]
async fn large_directories_stream_to_the_best_bounded_result() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..5000 {
        std::fs::write(dir.path().join(format!("f{index:04}.txt")), "x").unwrap();
    }
    let (items, truncated) = query(&root_of(&dir), "@", 50).await.unwrap();
    assert_eq!(items.len(), 50, "只有 limit 个结果");
    assert!(truncated, "匹配总数 5000 > 50 必须标记截断");
    // 排序后的前 50 个必须是最小的路径：不能按目录枚举顺序截断前 4096 项。
    let expected = (0..50)
        .map(|index| format!("f{index:04}.txt"))
        .collect::<Vec<_>>();
    let paths = items.iter().map(|e| e.path.clone()).collect::<Vec<_>>();
    assert_eq!(paths, expected);

    // 目录末尾的精确文件也要能找到：按名称查询只命中它，且 metadata 真实。
    std::fs::write(dir.path().join("zz-late-target.md"), "late").unwrap();
    let (items, truncated) = query(&root_of(&dir), "@zz-late", 50).await.unwrap();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0].path, "zz-late-target.md");
    assert_eq!(items[0].bytes, 4);
    assert_eq!(items[0].mime, "text/markdown");
    assert!(!truncated);
}
