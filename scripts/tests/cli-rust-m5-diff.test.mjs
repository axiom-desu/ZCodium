import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const step = (name, args) => ({ name, args });

// cargo 首次编译可能较慢，但 driver 卡死必须失败而不是让 CI 无限等待。
const DRIVER_TIMEOUT_MS = 180_000;

async function run(command, args, input, timeoutMs = DRIVER_TIMEOUT_MS) {
  // POSIX 下 cargo run 会再派生被测二进制，放进独立进程组才能连子进程一起 kill。
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (detached && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // fall back to killing just the direct child
      }
    }
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let code;
  try {
    code = await done;
  } finally {
    clearTimeout(timer);
  }
  assert.equal(
    code,
    0,
    timedOut
      ? `${command} driver timed out after ${timeoutMs}ms`
      : `${command} driver failed: ${stderr}`,
  );
  return stdout;
}

async function prepare(root, files) {
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function fileBytes(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  return Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [path.slice(root.length + 1), await readFile(path)]),
    ),
  );
}

function countPatchLines(structuredPatch) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of structuredPatch)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  return { additions, deletions };
}

/** Live TS `structuredPatch` vs the Rust `tool_fixture` driver for one session. */
async function differential(files, steps) {
  const root = await mkdtemp(join(tmpdir(), "zcode-rust-m5-tools-"));
  const tsRoot = join(root, "ts");
  const rustRoot = join(root, "rust");
  try {
    await Promise.all([prepare(tsRoot, files), prepare(rustRoot, files)]);
    const actions = steps.map(({ name, args }) => ({ name, args }));
    const [tsText, rustText] = await Promise.all([
      run(
        process.execPath,
        ["--import", "tsx", "scripts/zcode-cli-rust-m5-tool-oracle.mjs", "--check", tsRoot],
        JSON.stringify({ actions }),
      ),
      run(
        "cargo",
        [
          "run",
          "--offline",
          "--quiet",
          "--locked",
          "--manifest-path",
          "apps/zcode-cli-rust/Cargo.toml",
          "--example",
          "tool_fixture",
          "--",
          rustRoot,
        ],
        actions.map((action) => JSON.stringify(action)).join("\n") + "\n",
      ),
    ]);
    const oracle = JSON.parse(tsText);
    const rust = rustText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(oracle.length, steps.length);
    assert.equal(rust.length, steps.length);
    for (const [index, { name, args }] of steps.entries()) {
      const label = `${index}: ${name} ${JSON.stringify(args)}`;
      const tsResult = oracle[index];
      const rustResult = rust[index];
      assert.equal(tsResult.ok, rustResult.error === undefined, `outcome: ${label}`);
      if (name !== "Write" && name !== "Edit") continue;
      const expected = tsResult.output.structuredPatch;
      const actual = rustResult.data.structuredPatch;
      // 真实 jsdiff 多 hunk 是稳定契约：不排序、不合并、不硬编码期望值。
      assert.deepEqual(actual, expected, `structuredPatch: ${label}`);
      // TS 在 `type: "create"`/无 hunk 时没有 file_diff display，只比较有 hunk 的展示计数。
      if (expected.length === 0) continue;
      const counts = countPatchLines(expected);
      assert.equal(rustResult.display.additions, counts.additions, `additions: ${label}`);
      assert.equal(rustResult.display.deletions, counts.deletions, `deletions: ${label}`);
      assert.deepEqual(rustResult.display.structuredPatch, expected, `display: ${label}`);
    }
    assert.deepEqual(
      await fileBytes(rustRoot),
      await fileBytes(tsRoot),
      "final files must match byte-for-byte",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** `count` LF-terminated `L<n>` lines with `indexes` (0-based) replaced by `X<n>`. */
const lines = (count, ...indexes) =>
  Array.from({ length: count }, (_, i) => (indexes.includes(i) ? `X${i}` : `L${i + 1}`)).join(
    "\n",
  ) + (count > 0 ? "\n" : "");

/** Deterministic mulberry32 PRNG: the duplicate-line batch must be reproducible. */
function duplicateRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const DUPLICATE_ALPHABET = ["a", "b", "c", "d"];
const DUPLICATE_CASES = 300;

function duplicatePick(next, items) {
  return items[Math.floor(next() * items.length)];
}

function duplicateOldLines(next) {
  const count = 1 + Math.floor(next() * 10);
  return Array.from({ length: count }, () => duplicatePick(next, DUPLICATE_ALPHABET));
}

/** Random 1..3 insert/delete/replace/swap edits keep the repeated-line shape. */
function duplicateNewLines(next, oldLines) {
  const result = oldLines.slice();
  const edits = 1 + Math.floor(next() * 3);
  for (let edit = 0; edit < edits; edit += 1) {
    if (result.length === 0) {
      result.push(duplicatePick(next, DUPLICATE_ALPHABET));
      continue;
    }
    const at = Math.floor(next() * result.length);
    const roll = next();
    if (roll < 0.3) result.splice(at, 1);
    else if (roll < 0.6) result.splice(at, 0, duplicatePick(next, DUPLICATE_ALPHABET));
    else if (roll < 0.85) result[at] = duplicatePick(next, DUPLICATE_ALPHABET);
    else if (at + 1 < result.length) {
      [result[at], result[at + 1]] = [result[at + 1], result[at]];
    }
  }
  return result;
}

const duplicateText = (tokens) => (tokens.length === 0 ? "" : `${tokens.join("\n")}\n`);

/** Fixed-seed old→new pairs dominated by repeated lines and tie-break alignments. */
function duplicateLineCases(seed = 0x5eed) {
  const next = duplicateRandom(seed);
  const cases = [];
  while (cases.length < DUPLICATE_CASES) {
    const oldLines = duplicateOldLines(next);
    const newLines = duplicateNewLines(next, oldLines);
    const before = duplicateText(oldLines);
    const after = duplicateText(newLines);
    if (before !== after) cases.push({ before, after });
  }
  return cases;
}

// 每种形状都让 TS/jsdiff 和 Rust 计算同一 old→new；多/相邻/边界 hunk 的期望来自实时 oracle。
const scenarios = [
  ["single.txt", lines(12), lines(12, 5)],
  ["two-far.txt", lines(20), lines(20, 2, 16)],
  ["merge.txt", lines(20), lines(20, 2, 9)],
  ["gap-7.txt", lines(24), lines(24, 2, 10)],
  ["repeat.txt", "a\nb\na\nb\na\nb\n", "a\nb\na\nX\na\nb\n"],
  ["insert.txt", "a\nb\nc\n", "a\nb\nx\nc\n"],
  ["delete.txt", "a\nb\nc\nd\n", "a\nc\nd\n"],
  ["trailing-append.txt", "a\nb", "a\nb\nc"],
  ["trailing-replace.txt", "a\nb", "a\nX"],
  ["empty-to-text.txt", "", "a\nb\n"],
  ["text-to-empty.txt", "a\nb\n", ""],
  // CRLF 内容在 Write 适配器层被规范化为 LF（另一所有者），不在此 diff 切片比较。
  ["many.txt", lines(40), lines(40, 3, 12, 30)],
];

test("M5 diff: live jsdiff hunks match Rust for multi/adjacent/repeat/newline edges", async () => {
  const files = Object.fromEntries(scenarios.map(([name, before]) => [name, before]));
  const steps = [];
  for (const [name, , after] of scenarios) {
    steps.push(step("Read", { file_path: name }));
    steps.push(step("Write", { file_path: name, content: after }));
  }
  await differential(files, steps);
});

test("M5 diff: Edit replacement uses the same jsdiff hunk path", async () => {
  const before = lines(20);
  const after = lines(20, 2, 16);
  await differential({ "edit.txt": before }, [
    step("Read", { file_path: "edit.txt" }),
    step("Edit", { file_path: "edit.txt", old_string: before, new_string: after }),
  ]);
});

test("M5 diff: Edit create exercises diff(empty, new) beyond the Write create override", async () => {
  await differential({}, [
    step("Edit", { file_path: "created.txt", old_string: "", new_string: "a\nb\nc\nd\n" }),
  ]);
});

test("M5 diff: fixed-seed duplicate-line batch matches the live jsdiff oracle", async () => {
  // Hundreds of repeated-line old→new pairs in one oracle/fixture batch. The
  // live `structuredPatch` is the source of truth here: this is the regression
  // net for Myers tie-breaking (pre-trimming a common suffix changes which
  // duplicate line the winning path keeps).
  const cases = duplicateLineCases();
  const files = {};
  const steps = [];
  cases.forEach(({ before, after }, index) => {
    const name = `duplicate-${index}.txt`;
    files[name] = before;
    steps.push(step("Read", { file_path: name }));
    steps.push(step("Write", { file_path: name, content: after }));
  });
  await differential(files, steps);
});

test("M5 diff: driver timeout kills and awaits a hung subprocess", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], "", 100),
    /driver timed out after 100ms/,
  );
});
