//! jsdiff `base.js` Myers traversal: the shared path chains, `extractCommon`
//! and `buildValues`, ported with the timing checks that keep a long traversal
//! inside the caller's budget. Kept separate from [`super`] so the O(N·D)
//! algorithm stays next to the jsdiff source it mirrors.
use super::Part;
use std::rc::Rc;

/// How many common lines a single `extractCommon` scan advances before it
/// re-checks the deadline. The scan is a linear run, but a run can span the
/// whole middle after prefix trimming, so it must not be able to overshoot the
/// budget unchecked. A power of two keeps the test a bitmask.
const DEADLINE_CHECK_EVERY: usize = 4096;

/// A Myers path node. Chains are shared through `Rc`, so pruning a frontier
/// slot drops the nodes only that path kept; an index arena kept every
/// historical node alive until the whole diff returned, letting memory grow
/// with the edit count instead of the live frontier.
pub(super) struct Node {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<Rc<Node>>,
}

/// Unwind a path chain iteratively. The derived `Drop` would recurse once per
/// `previous` link, and an all-different diff builds one node per edit, so a
/// deep chain would overflow the stack when its last `Rc` went away.
impl Drop for Node {
    fn drop(&mut self) {
        let mut current = self.previous.take();
        while let Some(node) = current {
            match Rc::try_unwrap(node) {
                Ok(mut node) => current = node.previous.take(),
                // Still owned by a live frontier slot; that owner drops the
                // same chain later and unwinds it from there.
                Err(_) => break,
            }
        }
    }
}

/// A Myers state for one `(oldPos, diagonal)` frontier slot.
#[derive(Clone)]
struct Path {
    old_pos: i64,
    last: Option<Rc<Node>>,
}

/// jsdiff `line.ts::tokenize`: split on `\n`/`\r\n`, keep separators attached
/// to their line, then drop empty tokens. The returned slices borrow `value`,
/// which is equivalent to the JS tokenizer's `value + separator` concatenation.
pub(super) fn tokenize(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut lines: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            lines.push(&value[start..i + 1]);
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < bytes.len() {
        lines.push(&value[start..]);
    }
    lines.retain(|line| !line.is_empty());
    lines
}

/// jsdiff `base.js::addToPath`.
fn add_to_path(path: &Path, added: bool, removed: bool, inc: i64) -> Path {
    let last = match &path.last {
        Some(node) if node.added == added && node.removed == removed => Rc::new(Node {
            count: node.count + 1,
            added,
            removed,
            previous: node.previous.clone(),
        }),
        _ => Rc::new(Node {
            count: 1,
            added,
            removed,
            previous: path.last.clone(),
        }),
    };
    Path {
        old_pos: path.old_pos + inc,
        last: Some(last),
    }
}

/// jsdiff `base.js::extractCommon`. Returns the final new position, or `None`
/// when the deadline predicate trips during a long common run. The predicate is
/// sampled, not checked per line, so the production clock read stays off the
/// hot comparison path.
fn extract_common(
    base: &mut Path,
    old: &[&str],
    new: &[&str],
    diagonal: i64,
    expired: &mut dyn FnMut() -> bool,
) -> Option<i64> {
    let (old_len, new_len) = (old.len() as i64, new.len() as i64);
    let mut old_pos = base.old_pos;
    let mut new_pos = old_pos - diagonal;
    let mut common = 0usize;
    while new_pos + 1 < new_len
        && old_pos + 1 < old_len
        && old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize]
    {
        new_pos += 1;
        old_pos += 1;
        common += 1;
        if common.is_multiple_of(DEADLINE_CHECK_EVERY) && expired() {
            return None;
        }
    }
    if common > 0 {
        let previous = base.last.take();
        base.last = Some(Rc::new(Node {
            count: common,
            added: false,
            removed: false,
            previous,
        }));
    }
    base.old_pos = old_pos;
    Some(new_pos)
}

/// jsdiff `base.js::buildValues`: walk the winning chain into ordered parts.
fn build_values<'a>(last: Option<Rc<Node>>, old: &[&'a str], new: &[&'a str]) -> Vec<Part<'a>> {
    let mut chain = Vec::new();
    let mut current = last;
    while let Some(node) = current {
        current = node.previous.clone();
        chain.push(node);
    }
    chain.reverse();
    let mut parts = Vec::with_capacity(chain.len());
    let (mut old_pos, mut new_pos) = (0usize, 0usize);
    for node in chain {
        if node.removed {
            parts.push(Part {
                added: false,
                removed: true,
                lines: old[old_pos..old_pos + node.count].to_vec(),
            });
            old_pos += node.count;
        } else {
            parts.push(Part {
                added: node.added,
                removed: false,
                lines: new[new_pos..new_pos + node.count].to_vec(),
            });
            new_pos += node.count;
            if !node.added {
                old_pos += node.count;
            }
        }
    }
    parts
}

/// jsdiff `base.js::diffWithOptionsObj` with the default line options
/// (no ignore rules, no callback, no `oneChangePerToken`). `expired` mirrors
/// jsdiff's `Date.now() > abortAfterTimestamp`: `None` is the timeout path that
/// `structuredPatch` folds to no hunks.
pub(super) fn diff<'a>(
    old: &[&'a str],
    new: &[&'a str],
    expired: &mut dyn FnMut() -> bool,
) -> Option<Vec<Part<'a>>> {
    let (old_len, new_len) = (old.len() as i64, new.len() as i64);
    let mut best: std::collections::HashMap<i64, Path> = std::collections::HashMap::new();
    let mut seed = Path {
        old_pos: -1,
        last: None,
    };
    let mut new_pos = extract_common(&mut seed, old, new, 0, expired)?;
    if seed.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        return Some(build_values(seed.last, old, new));
    }
    best.insert(0, seed);
    let (mut min_diagonal, mut max_diagonal) = (i64::MIN, i64::MAX);
    let mut edit_length = 1i64;
    let max_edit_length = new_len + old_len;
    while edit_length <= max_edit_length {
        // jsdiff only checks the deadline between edit lengths; checking the
        // inner diagonal sweep and long common runs too keeps a single O(ND)
        // level from overshooting the budget while still producing the same
        // timeout result.
        if expired() {
            return None;
        }
        let mut diagonal = (-edit_length).max(min_diagonal);
        while diagonal <= edit_length.min(max_diagonal) {
            if expired() {
                return None;
            }
            let remove = best.get(&(diagonal - 1)).cloned();
            let add = best.get(&(diagonal + 1)).cloned();
            if remove.is_some() {
                best.remove(&(diagonal - 1));
            }
            let can_add = add.as_ref().is_some_and(|path| {
                let position = path.old_pos - diagonal;
                (0..new_len).contains(&position)
            });
            let can_remove = remove
                .as_ref()
                .is_some_and(|path| path.old_pos + 1 < old_len);
            if !can_add && !can_remove {
                best.remove(&diagonal);
                diagonal += 2;
                continue;
            }
            let mut base = if !can_remove
                || (can_add && remove.as_ref().unwrap().old_pos < add.as_ref().unwrap().old_pos)
            {
                add_to_path(add.as_ref().unwrap(), true, false, 0)
            } else {
                add_to_path(remove.as_ref().unwrap(), false, true, 1)
            };
            new_pos = extract_common(&mut base, old, new, diagonal, expired)?;
            if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                return Some(build_values(base.last, old, new));
            }
            let old_at_end = base.old_pos + 1 >= old_len;
            best.insert(diagonal, base);
            if old_at_end {
                max_diagonal = max_diagonal.min(diagonal - 1);
            }
            if new_pos + 1 >= new_len {
                min_diagonal = min_diagonal.max(diagonal + 1);
            }
            diagonal += 2;
        }
        edit_length += 1;
    }
    Some(Vec::new())
}

/// Builds a `count`-deep path chain for the drop-recursion regression test; the
/// deep chain is never reachable through the normal diff entry points without a
/// full O(N·D) run.
#[cfg(test)]
pub(super) fn deep_chain(count: usize) -> Option<Rc<Node>> {
    let mut last = None;
    for _ in 0..count {
        last = Some(Rc::new(Node {
            count: 1,
            added: false,
            removed: false,
            previous: last,
        }));
    }
    last
}

#[cfg(test)]
mod tests {
    use super::{Path, extract_common};

    #[test]
    fn long_common_run_samples_the_deadline() {
        // `extractCommon` advances a whole common run before the outer diagonal
        // loop can check again, so it must sample the deadline itself. A run
        // longer than the sampling interval trips on the first sample instead
        // of scanning the whole run first.
        let old_storage: Vec<String> = (0..5_000).map(|n| n.to_string()).collect();
        let new_storage = old_storage.clone();
        let old: Vec<&str> = old_storage.iter().map(String::as_str).collect();
        let new: Vec<&str> = new_storage.iter().map(String::as_str).collect();
        let mut path = Path {
            old_pos: -1,
            last: None,
        };
        let mut checks = 0usize;
        let result = extract_common(&mut path, &old, &new, 0, &mut || {
            checks += 1;
            true
        });
        assert_eq!(result, None);
        assert_eq!(checks, 1, "sampled once inside the run");
    }
}
