use super::discover;
use tokio_util::sync::CancellationToken;

fn write_skill(root: &std::path::Path, name: &str) {
    let dir = root.join(".zcodium").join("skills").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {name} skill\n---\nbody\n"),
    )
    .unwrap();
}

#[tokio::test]
async fn additional_directories_add_project_skill_roots_without_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("main");
    let extra = tmp.path().join("shared");
    std::fs::create_dir_all(&cwd).unwrap();
    write_skill(&cwd, "main-skill");
    write_skill(&extra, "shared-skill");
    let config = serde_json::json!({"skills": {"roots": []}});
    let dirs = vec![
        extra.to_string_lossy().into_owned(),
        cwd.to_string_lossy().into_owned(),
    ];
    let catalog = discover(&cwd, &config, &dirs, &CancellationToken::new())
        .await
        .unwrap();
    let names = catalog
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"shared-skill"));
    assert_eq!(
        names.iter().filter(|name| **name == "main-skill").count(),
        1
    );
}
