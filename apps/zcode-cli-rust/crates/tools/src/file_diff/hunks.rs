//! jsdiff `patch/create.ts::diffLinesResultToPatch`: the hunk pass that groups
//! `buildValues` parts, merges equal runs of at most `2 * context` lines, and
//! rewrites trailing newlines into the `\ No newline at end of file` marker.
use super::{CONTEXT, NO_NEWLINE, Part};
use serde_json::{Value, json};

/// Groups `parts` into hunks and returns the hunk array plus the
/// `countPatchLines` additions/deletions.
pub(super) fn build_hunks(parts: &mut Vec<Part<'_>>) -> (Vec<Value>, usize, usize) {
    // jsdiff appends `{ value: '', lines: [] }` to close a range at EOF.
    parts.push(Part {
        added: false,
        removed: false,
        lines: Vec::new(),
    });
    let diff_len = parts.len();
    let mut hunks: Vec<Value> = Vec::new();
    let mut old_range_start: i64 = 0;
    let mut new_range_start: i64 = 0;
    let mut range: Vec<String> = Vec::new();
    let mut old_line: i64 = 1;
    let mut new_line: i64 = 1;
    for index in 0..diff_len {
        let (added, removed) = (parts[index].added, parts[index].removed);
        let lines = &parts[index].lines;
        if added || removed {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if index > 0 && CONTEXT > 0 {
                    let previous = &parts[index - 1].lines;
                    for line in &previous[previous.len().saturating_sub(CONTEXT)..] {
                        range.push(format!(" {line}"));
                    }
                    old_range_start -= range.len() as i64;
                    new_range_start -= range.len() as i64;
                }
            }
            for line in lines {
                range.push(format!("{}{line}", if added { '+' } else { '-' }));
            }
            if added {
                new_line += lines.len() as i64;
            } else {
                old_line += lines.len() as i64;
            }
        } else if old_range_start != 0 {
            if lines.len() <= CONTEXT * 2 && index < diff_len - 2 {
                for line in lines {
                    range.push(format!(" {line}"));
                }
            } else {
                let context_size = lines.len().min(CONTEXT);
                for line in &lines[..context_size] {
                    range.push(format!(" {line}"));
                }
                hunks.push(json!({
                    "oldStart": old_range_start,
                    "oldLines": old_line - old_range_start + context_size as i64,
                    "newStart": new_range_start,
                    "newLines": new_line - new_range_start + context_size as i64,
                    "lines": range,
                }));
                old_range_start = 0;
                new_range_start = 0;
                range = Vec::new();
            }
        }
        if !added && !removed {
            old_line += lines.len() as i64;
            new_line += lines.len() as i64;
        }
    }
    let (mut additions, mut deletions) = (0usize, 0usize);
    for hunk in &mut hunks {
        let lines = hunk["lines"].as_array_mut().expect("hunk lines");
        let mut index = 0;
        while index < lines.len() {
            let text = lines[index].as_str().expect("hunk line").to_owned();
            if let Some(stripped) = text.strip_suffix('\n') {
                lines[index] = Value::String(stripped.to_owned());
            } else {
                lines.insert(index + 1, Value::String(NO_NEWLINE.to_owned()));
                index += 1;
            }
            match text.chars().next() {
                Some('+') => additions += 1,
                Some('-') => deletions += 1,
                _ => {}
            }
            index += 1;
        }
    }
    (hunks, additions, deletions)
}
