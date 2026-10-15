//! jsdiff parity unit tests for `file_diff::patch`; the live TS oracle driver
//! `scripts/tests/cli-rust-m5-diff.test.mjs` remains the differential source,
//! including the fixed-seed duplicate-line batch.
use super::{patch, patch_async_with, patch_inner};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn lines(count: usize) -> String {
    (1..=count)
        .map(|n| format!("L{n}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn edited(count: usize, indexes: &[usize]) -> String {
    (1..=count)
        .map(|n| {
            if indexes.contains(&(n - 1)) {
                format!("X{}", n - 1)
            } else {
                format!("L{n}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn hunks(old: &str, new: &str) -> Value {
    patch(old, new).0
}

fn hunk(start: i64, old_lines: i64, new_lines: i64, lines: Value) -> Value {
    json!({"oldStart": start, "oldLines": old_lines, "newStart": start, "newLines": new_lines, "lines": lines})
}

#[test]
fn single_change_uses_three_context_lines() {
    let (result, additions, deletions) = patch(&lines(12), &edited(12, &[5]));
    assert_eq!(additions, 1);
    assert_eq!(deletions, 1);
    assert_eq!(
        result,
        json!([hunk(
            3,
            7,
            7,
            json!([" L3", " L4", " L5", "-L6", "+X5", " L7", " L8", " L9"])
        )])
    );
}

#[test]
fn far_changes_produce_separate_hunks() {
    assert_eq!(
        hunks(&lines(20), &edited(20, &[2, 16])),
        json!([
            hunk(
                1,
                6,
                6,
                json!([" L1", " L2", "-L3", "+X2", " L4", " L5", " L6"])
            ),
            hunk(
                14,
                7,
                7,
                json!([
                    " L14", " L15", " L16", "-L17", "+X16", " L18", " L19", " L20"
                ])
            ),
        ])
    );
}

#[test]
fn gaps_of_at_most_six_lines_merge_into_one_hunk() {
    assert_eq!(
        hunks(&lines(20), &edited(20, &[2, 9])),
        json!([hunk(
            1,
            13,
            13,
            json!([
                " L1", " L2", "-L3", "+X2", " L4", " L5", " L6", " L7", " L8", " L9", "-L10",
                "+X9", " L11", " L12", " L13"
            ])
        )])
    );
}

#[test]
fn gaps_of_seven_lines_stay_separate() {
    assert_eq!(
        hunks(&lines(24), &edited(24, &[2, 10])),
        json!([
            hunk(
                1,
                6,
                6,
                json!([" L1", " L2", "-L3", "+X2", " L4", " L5", " L6"])
            ),
            hunk(
                8,
                7,
                7,
                json!([" L8", " L9", " L10", "-L11", "+X10", " L12", " L13", " L14"])
            ),
        ])
    );
}

#[test]
fn repeated_lines_keep_the_myers_alignment() {
    assert_eq!(
        hunks("a\nb\na\nb\na\nb\n", "a\nb\na\nX\na\nb\n"),
        json!([hunk(
            1,
            6,
            6,
            json!([" a", " b", " a", "-b", "+X", " a", " b"])
        )])
    );
}

#[test]
fn insert_and_delete_change_hunk_sizes() {
    assert_eq!(
        hunks("a\nb\nc\n", "a\nb\nx\nc\n"),
        json!([hunk(1, 3, 4, json!([" a", " b", "+x", " c"]))])
    );
    assert_eq!(
        hunks("a\nb\nc\nd\n", "a\nc\nd\n"),
        json!([hunk(1, 4, 3, json!([" a", "-b", " c", " d"]))])
    );
}

#[test]
fn missing_trailing_newline_adds_the_marker() {
    let (result, additions, deletions) = patch("a\nb", "a\nb\nc");
    assert_eq!(additions, 2);
    assert_eq!(deletions, 1);
    assert_eq!(
        result,
        json!([hunk(
            1,
            2,
            3,
            json!([
                " a",
                "-b",
                "\\ No newline at end of file",
                "+b",
                "+c",
                "\\ No newline at end of file"
            ])
        )])
    );
    assert_eq!(
        hunks("a\nb", "a\nX"),
        json!([hunk(
            1,
            2,
            2,
            json!([
                " a",
                "-b",
                "\\ No newline at end of file",
                "+X",
                "\\ No newline at end of file"
            ])
        )])
    );
}

#[test]
fn crlf_context_lines_keep_carriage_returns() {
    assert_eq!(
        hunks("a\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nX\r\nd\r\n"),
        json!([hunk(
            1,
            4,
            4,
            json!([" a\r", " b\r", "-c\r", "+X\r", " d\r"])
        )])
    );
    assert_eq!(
        hunks("a\r\nb\r\nc", "a\r\nb\r\nX"),
        json!([hunk(
            1,
            3,
            3,
            json!([
                " a\r",
                " b\r",
                "-c",
                "\\ No newline at end of file",
                "+X",
                "\\ No newline at end of file"
            ])
        )])
    );
}

#[test]
fn empty_sides_zero_out_the_matching_hunk_size() {
    assert_eq!(
        hunks("", "a\nb\n"),
        json!([hunk(1, 0, 2, json!(["+a", "+b"]))])
    );
    assert_eq!(
        hunks("a\nb\n", ""),
        json!([hunk(1, 2, 0, json!(["-a", "-b"]))])
    );
    assert_eq!(patch("same\n", "same\n"), (json!([]), 0, 0));
}

#[test]
fn common_prefix_trim_keeps_the_large_file_window() {
    // 10k identical lines around one change: the prefix trim must still emit the
    // same 3-context hunk as the full Myers traversal. The shared suffix is not
    // pre-trimmed (that would be a tie-break deviation); the winning Myers path
    // consumes it through `extractCommon` instead.
    assert_eq!(
        hunks(&lines(10_000), &edited(10_000, &[5_000])),
        json!([hunk(
            4_998,
            7,
            7,
            json!([
                " L4998", " L4999", " L5000", "-L5001", "+X5000", " L5002", " L5003", " L5004"
            ])
        )])
    );
}

#[test]
fn duplicate_lines_do_not_assume_a_common_suffix() {
    // jsdiff picks this edit script by diagonal order, not by the shared tail:
    // it keeps the first `a` and appends the new `a` at the end. Pre-trimming
    // the common suffix would move the addition before the shared `a`. Expected
    // value captured from the live oracle (`structuredPatch` in diff@9.0.0).
    assert_eq!(
        hunks("a\nb\na\n", "b\na\na\n"),
        json!([hunk(1, 3, 3, json!(["-a", " b", " a", "+a"]))])
    );
}

#[test]
fn deep_path_chain_drops_without_recursing() {
    // An all-different diff builds one `Node` per edit, so the winning chain can
    // be as long as the input. The default recursive drop would overflow the
    // stack on this chain; the manual `Drop for Node` unwinds it iteratively.
    assert!(super::myers::deep_chain(500_000).is_some());
}

#[test]
fn injected_deadline_aborts_myers_and_returns_the_ts_timeout_shape() {
    // 500 all-different lines need many Myers edit lengths; a predicate that
    // only trips after repeated checks proves the traversal checks mid-loop
    // instead of once up front, without waiting out the real 5s budget.
    let old = lines(500);
    let new = old.replace('L', "X");
    let mut checks = 0usize;
    let result = patch_inner(&old, &new, &mut || {
        checks += 1;
        checks > 8
    });
    assert_eq!(result, (json!([]), 0, 0));
    assert!(checks > 8, "deadline was checked {checks} times");
}

#[tokio::test]
async fn large_diff_runs_off_thread_and_aborts_on_signal() {
    // A current-thread tokio test only reaches the watcher task if the diff is
    // off the runtime thread. The predicate records whether it actually saw the
    // watcher's signal: a regression that runs the loop on the runtime thread
    // would only abort on the fallback and fail this assertion. The 30s fallback
    // bounds such a regression without slowing the happy path.
    let old = lines(40_000);
    let new = old.replace('L', "X");
    let checks = Arc::new(AtomicUsize::new(0));
    let started = Arc::clone(&checks);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let watcher = tokio::spawn(async move {
        while started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        flag.store(true, Ordering::SeqCst);
    });
    let observed = Arc::clone(&checks);
    let halt = Arc::clone(&stop);
    let saw_signal = Arc::new(AtomicBool::new(false));
    let signal_seen = Arc::clone(&saw_signal);
    let fallback = Instant::now() + Duration::from_secs(30);
    let (_, _, hunks, additions, deletions) = patch_async_with(old, new, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        let halt = halt.load(Ordering::SeqCst);
        if halt {
            signal_seen.store(true, Ordering::SeqCst);
        }
        halt || Instant::now() >= fallback
    })
    .await
    .unwrap();
    watcher.await.unwrap();
    assert!(checks.load(Ordering::SeqCst) > 0, "diff never started");
    assert!(
        saw_signal.load(Ordering::SeqCst),
        "diff aborted on the fallback instead of the watcher signal"
    );
    assert_eq!(hunks, json!([]));
    assert_eq!((additions, deletions), (0, 0));
}
