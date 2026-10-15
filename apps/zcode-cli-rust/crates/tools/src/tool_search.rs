use super::tools::{boolean, check_cancel, keys, resolve, string, uint};
use crate::contract::ToolOutput;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::Read,
    path::Path,
    time::{Duration, Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

pub async fn search(
    cwd: &Path,
    name: &str,
    args: &Value,
    cancel: &CancellationToken,
) -> Result<ToolOutput> {
    let token = cancel.child_token();
    let _guard = token.clone().drop_guard();
    let cwd = cwd.to_owned();
    let name = name.to_owned();
    let args = args.clone();
    let job = tokio::task::spawn_blocking(move || search_sync(&cwd, &name, &args, &token));
    tokio::select! {
        _=cancel.cancelled()=>bail!("Search cancelled"),
        result=tokio::time::timeout(Duration::from_secs(30),job)=>result.context("Search timed out")??,
    }
}
fn search_sync(
    cwd: &Path,
    name: &str,
    args: &Value,
    cancel: &CancellationToken,
) -> Result<ToolOutput> {
    let start = Instant::now();
    keys(
        args,
        if name == "Glob" {
            &["pattern", "path"]
        } else {
            &[
                "pattern",
                "path",
                "glob",
                "output_mode",
                "-A",
                "-B",
                "-C",
                "context",
                "-n",
                "-i",
                "-o",
                "type",
                "head_limit",
                "offset",
                "multiline",
            ]
        },
    )?;
    let root = resolve(
        cwd,
        args.get("path")
            .map(|_| string(args, "path"))
            .transpose()?
            .unwrap_or("."),
    )?;
    if !root.exists() {
        bail!("Search path does not exist");
    }
    if name == "Glob" && !root.is_dir() {
        bail!("Glob path must be a directory");
    }
    // 当前 TS adapter 会 trim 并拒绝空 pattern，不能把空正则当作全文件匹配。
    let pattern = string(args, "pattern")?.trim();
    if pattern.is_empty() {
        bail!("{name} pattern must not be empty");
    }
    let glob = if name == "Glob" {
        Some(pattern)
    } else {
        args.get("glob").map(|_| string(args, "glob")).transpose()?
    };
    let matcher = glob
        .map(|p| {
            globset::GlobBuilder::new(p)
                .literal_separator(false)
                .build()
                .map(|g| g.compile_matcher())
        })
        .transpose()?;
    let mut walk = ignore::WalkBuilder::new(&root);
    walk.hidden(false).follow_links(false).require_git(false);
    if let Some(t) = args.get("type") {
        let mut types = ignore::types::TypesBuilder::new();
        types.add_defaults();
        types.select(t.as_str().context("type must be a string")?);
        walk.types(types.build()?);
    }
    let display = |p: &Path| {
        p.strip_prefix(cwd)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/")
    };
    let mut truncated = false;
    if name == "Glob" {
        let mut matched = vec![];
        for entry in walk.build() {
            check_cancel(cancel)?;
            let e = entry?;
            if !e.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if !matcher
                .as_ref()
                .unwrap()
                .is_match(e.path().strip_prefix(&root).unwrap_or(e.path()))
            {
                continue;
            }
            let modified = e.metadata()?.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            matched.push((modified, display(e.path())));
            if matched.len() > 100 {
                matched.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                matched.truncate(100);
                truncated = true;
            }
        }
        matched.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let paths: Vec<_> = matched.into_iter().map(|p| p.1).collect();
        let mut text = if paths.is_empty() {
            "No files found".to_owned()
        } else {
            paths.join("\n")
        };
        if truncated {
            text.push_str(
                "\n(Results are truncated. Consider using a more specific path or pattern.)",
            );
        }
        return Ok(ToolOutput::new(
            text,
            json!({"durationMs":start.elapsed().as_millis() as u64,"numFiles":paths.len(),"filenames":paths,"truncated":truncated}),
        ));
    }
    let mode = args
        .get("output_mode")
        .map(|_| string(args, "output_mode"))
        .transpose()?
        .unwrap_or("files_with_matches");
    if !["content", "files_with_matches", "count"].contains(&mode) {
        bail!("Invalid output_mode");
    }
    let multiline = boolean(args, "multiline", false)?;
    let only = boolean(args, "-o", false)?;
    let numbers = boolean(args, "-n", true)?;
    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(boolean(args, "-i", false)?)
        .multi_line(true)
        .dot_matches_new_line(multiline)
        .size_limit(2 * 1024 * 1024)
        .build()?;
    let offset = uint(args, "offset", 0)? as usize;
    let requested_limit = uint(args, "head_limit", 250)? as usize;
    let limit = if requested_limit == 0 {
        usize::MAX
    } else {
        requested_limit
    };
    // TS grep.ts 取 `contextLines = parsed.context ?? parsed["-C"]`，fs adapter 的
    // addRipgrepContextArgs 在 contextLines 已定义时只向 ripgrep 传 `-C` 并提前返回，
    // 同时给出的 `-B`/`-A` 被忽略；只有没有 context/-C 时才分别传 -B/-A。oracle 默认走
    // bundled ripgrep 的 rg JSON 路径（parseRipgrepJsonOutput），不是
    // searchTextWithJavaScript fallback（后者才会用 -B/-A 覆盖 context）。因此这里对齐 rg
    // 路径：context/-C 存在时（显式 0 也算已定义，`??` 只跳过 null/undefined）before/after
    // 都取该值，否则沿用 -B/-A。
    let context_lines = if args.get("context").is_some() {
        Some(uint(args, "context", 0)? as usize)
    } else if args.get("-C").is_some() {
        Some(uint(args, "-C", 0)? as usize)
    } else {
        None
    };
    let (before, after) = match context_lines {
        Some(context) => {
            let context = context.min(10_000);
            (context, context)
        }
        None => (
            uint(args, "-B", 0)?.min(10_000) as usize,
            uint(args, "-A", 0)?.min(10_000) as usize,
        ),
    };
    let mut entries = vec![];
    let mut filenames = BTreeSet::new();
    let mut file_matches = vec![];
    let mut matched_count = 0;
    let mut seen = 0;
    let mut bytes = 0;
    let mut push = |text: String| {
        seen += 1;
        if seen <= offset {
            return;
        }
        if entries.len() >= limit || bytes + text.len() > 20_000 {
            truncated = true;
            return;
        }
        bytes += text.len();
        entries.push(text);
    };
    for entry in walk.build() {
        check_cancel(cancel)?;
        let e = entry?;
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Some(m) = &matcher
            && !m.is_match(e.path().strip_prefix(&root).unwrap_or(e.path()))
        {
            continue;
        }
        let mut data = Vec::new();
        std::fs::File::open(e.path())?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut data)?;
        check_cancel(cancel)?;
        if data.contains(&0) {
            continue;
        }
        if data.len() > 16 * 1024 * 1024 {
            bail!("grep_too_large: narrow the search; file exceeds 16 MiB");
        }
        // ripgrep 会剥离文件起始的 UTF-8 BOM；Read 保留 BOM，Grep 必须跟随该差异。
        let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&data);
        let content = String::from_utf8_lossy(data);
        let raw_lines = super::tool_search_format::grep_raw_lines(data);
        // ripgrep JSON 对含非法 UTF-8 的行只输出 bytes 字段，TS adapter 读不到 text 时为
        // 空字符串；这里同样按 raw 行字节判定，避免 lossy 文本泄漏到 content/context。
        let line_valid: Vec<bool> = raw_lines
            .iter()
            .map(|line| std::str::from_utf8(line).is_ok())
            .collect();
        let lines: Vec<String> = raw_lines
            .iter()
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect();
        let path = display(e.path());
        if mode != "content" {
            let count = if multiline {
                re.find_iter(&content).count()
            } else {
                lines.iter().filter(|line| re.is_match(line)).count()
            };
            if count == 0 {
                continue;
            }
            matched_count += count;
            filenames.insert(path.clone());
            if mode == "files_with_matches" {
                file_matches.push((
                    e.metadata()?.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    path,
                ));
            } else {
                push(format!("{path}:{count}"));
            }
            continue;
        }
        let mut hits = BTreeSet::new();
        let mut only_matches = vec![];
        if multiline {
            let starts: Vec<_> = std::iter::once(0)
                .chain(
                    content
                        .bytes()
                        .enumerate()
                        .filter(|(_, b)| *b == b'\n')
                        .map(|(i, _)| i + 1),
                )
                .collect();
            for m in re.find_iter(&content) {
                check_cancel(cancel)?;
                let first = starts
                    .partition_point(|offset| *offset <= m.start())
                    .saturating_sub(1);
                let last = first + m.as_str().bytes().filter(|b| *b == b'\n').count();
                hits.extend(first..=last);
                if only {
                    only_matches.push((first, m.as_str().to_owned()));
                }
            }
        } else {
            for (i, line) in lines.iter().enumerate() {
                for m in re.find_iter(line) {
                    hits.insert(i);
                    if only && !m.is_empty() {
                        only_matches.push((i, m.as_str().to_owned()));
                    }
                }
            }
        }
        if hits.is_empty() {
            continue;
        }
        matched_count += hits.len();
        filenames.insert(path.clone());
        if only {
            for (i, m) in only_matches {
                push(if numbers {
                    format!("{path}:{}:{m}", i + 1)
                } else {
                    format!("{path}:{m}")
                });
            }
        } else {
            let mut visible = BTreeSet::new();
            for &i in &hits {
                visible.extend(
                    i.saturating_sub(before)
                        ..=i.saturating_add(after).min(lines.len().saturating_sub(1)),
                );
            }
            for i in visible {
                let Some(line) = lines.get(i) else { continue };
                // 非 UTF-8 行与 ripgrep JSON text 缺省一致，输出空文本。
                let line = if line_valid.get(i).copied().unwrap_or(false) {
                    line.as_str()
                } else {
                    ""
                };
                let separator = ":";
                push(if numbers {
                    format!("{path}{separator}{}{separator}{line}", i + 1)
                } else {
                    format!("{path}{separator}{line}")
                });
            }
        }
    }
    // TS 文件模式先按 mtime 排序再分页；content/count 的 numFiles 与总匹配不受分页影响。
    if mode == "files_with_matches" {
        file_matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        truncated = file_matches.len().saturating_sub(offset) > limit;
        entries = file_matches
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, path)| path)
            .collect();
    }
    let count = if mode == "files_with_matches" {
        entries.len()
    } else {
        filenames.len()
    };
    let text = entries.join("\n");
    let mut output = json!({"mode":mode,"durationMs":start.elapsed().as_millis() as u64,"numFiles":count,"filenames":if mode=="files_with_matches"{entries.clone()}else{vec![]},"truncated":truncated,"numMatches":matched_count});
    // TS 只在发生截断或 offset > 0 时带分页字段，默认 250/0 不是输出事实。
    if truncated && requested_limit > 0 {
        output["appliedLimit"] = requested_limit.into();
    }
    if offset > 0 {
        output["appliedOffset"] = offset.into();
    }
    if mode != "files_with_matches" {
        output["content"] = text.clone().into();
        if mode == "content" {
            output["numLines"] = entries.len().into();
        }
    }
    // TS 的模型文案由结构化输出推导，三种模式与分页提示必须逐字对齐。
    let model = super::tool_search_format::grep_model(&output);
    Ok(ToolOutput::new(model, output))
}
