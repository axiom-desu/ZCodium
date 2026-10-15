//! jsdiff `structuredPatch` parity (the `diff` npm package v9.0.0) for the
//! Write/Edit result and the checkpoint summary.
//!
//! TS `core/src/tool/diff.ts::createStructuredPatch` calls
//! `structuredPatch(old, new, { context: 3, timeout: 5_000 })`; that hunk array
//! is the single patch producer feeding adapter data, `file_diff` display and
//! checkpoint summaries, so this module owns the one production path. The
//! implementation ports jsdiff's Myers diff (`diff/base.js`, `diff/line.js`) and
//! its hunk builder (`patch/create.js`) instead of approximating a single change
//! range, and reproduces the 5s timeout: jsdiff returns `undefined` when the
//! edit-length loop passes the deadline, so `createStructuredPatch` folds the
//! result to `[]` and `countPatchLines` reports `0`/`0` additions/deletions.
//!
//! The Myers traversal lives in [`myers`] and the hunk pass in [`hunks`]; this
//! file keeps the jsdiff budget and the single `patch_inner` orchestration.
use serde_json::{Value, json};
use std::time::{Duration, Instant};

mod hunks;
mod myers;

/// `diff.ts::CONTEXT_LINES`.
const CONTEXT: usize = 3;
/// `diff.ts::DIFF_TIMEOUT_MS`; jsdiff checks it inside the Myers edit-length
/// loop and aborts the whole diff once the wall clock passes it.
const DIFF_TIMEOUT: Duration = Duration::from_millis(5_000);
/// jsdiff's end-of-file marker line.
const NO_NEWLINE: &str = "\\ No newline at end of file";

/// One `buildValues` component: the changed/equal line text grouped exactly
/// like jsdiff, before the `structuredPatch` hunk pass. Lines borrow the
/// caller's text, so tokenizing does not copy every line.
struct Part<'a> {
    added: bool,
    removed: bool,
    lines: Vec<&'a str>,
}

/// The shared algorithm entry: exactly one diff path, reachable from the
/// blocking wrapper and the tests. `expired` returns `true` on the TS timeout
/// path, which yields the empty hunks / zero counts jsdiff produces.
fn patch_inner(old: &str, new: &str, expired: &mut dyn FnMut() -> bool) -> (Value, usize, usize) {
    if old == new {
        return (json!([]), 0, 0);
    }
    let old_tokens = myers::tokenize(old);
    let new_tokens = myers::tokenize(new);
    if expired() {
        return (json!([]), 0, 0);
    }
    // jsdiff consumes the maximal common prefix at editLength 0 (`extractCommon`
    // on the seed path), so trimming it before Myers is equivalent and keeps the
    // frontier small for the typical "small edit in a large file" case.
    //
    // The common suffix is deliberately NOT trimmed up front. Myers only knows
    // the sequences, and among equal-length edit scripts it picks one by
    // diagonal order, not by whether a shared tail exists. Removing the suffix
    // first changes that tie-breaking on duplicate lines (for example
    // `a\nb\na\n` -> `b\na\na\n`: jsdiff keeps the first `a` and appends the
    // trailing one; pre-trimming instead puts the addition before the shared
    // `a`). Prefix trimming has no such ambiguity because jsdiff always consumes
    // the prefix first.
    let mut prefix = 0;
    while prefix < old_tokens.len()
        && prefix < new_tokens.len()
        && old_tokens[prefix] == new_tokens[prefix]
    {
        prefix += 1;
    }
    let mut parts: Vec<Part<'_>> = Vec::new();
    if prefix > 0 {
        parts.push(Part {
            added: false,
            removed: false,
            lines: old_tokens[..prefix].to_vec(),
        });
    }
    match myers::diff(&old_tokens[prefix..], &new_tokens[prefix..], expired) {
        Some(diffed) => parts.extend(diffed),
        None => return (json!([]), 0, 0),
    }
    let (hunks, additions, deletions) = hunks::build_hunks(&mut parts);
    (Value::Array(hunks), additions, deletions)
}

/// jsdiff `structuredPatch(old, new, { context: 3, timeout: 5_000 })` hunks
/// plus the `countPatchLines` additions/deletions; `old == new` yields no hunk.
/// Synchronous entry point for tests; async callers use [`patch_async`] so the
/// O(N·D) traversal never runs on a tokio worker thread.
#[cfg(test)]
pub(super) fn patch(old: &str, new: &str) -> (Value, usize, usize) {
    let deadline = Instant::now() + DIFF_TIMEOUT;
    let mut expired = || Instant::now() >= deadline;
    patch_inner(old, new, &mut expired)
}

/// Runs one structured diff on the blocking pool with the TS 5s budget. The
/// owned inputs are returned so a Write/Edit caller that still needs the
/// original text does not clone it. A worker panic becomes an error rather than
/// being folded into the timeout result.
pub(super) async fn patch_async(
    old: String,
    new: String,
) -> anyhow::Result<(String, String, Value, usize, usize)> {
    // 在 blocking 线程首次检查时才计时，避免线程池排队时间占用 5s 预算。
    let mut expires_at = None;
    patch_async_with(old, new, move || {
        let expires_at = expires_at.get_or_insert_with(|| Instant::now() + DIFF_TIMEOUT);
        Instant::now() >= *expires_at
    })
    .await
}

/// [`patch_async`] with an injectable abort predicate, so tests can force the
/// timeout path deterministically instead of waiting out `DIFF_TIMEOUT`.
async fn patch_async_with<F>(
    old: String,
    new: String,
    mut expired: F,
) -> anyhow::Result<(String, String, Value, usize, usize)>
where
    F: FnMut() -> bool + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let (hunks, additions, deletions) = patch_inner(&old, &new, &mut expired);
        (old, new, hunks, additions, deletions)
    })
    .await
    .map_err(|error| anyhow::anyhow!("structured diff worker failed: {error}"))
}

#[cfg(test)]
#[path = "file_diff_tests.rs"]
mod tests;
