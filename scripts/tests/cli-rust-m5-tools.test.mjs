import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTsOracle } from "../zcode-cli-rust-m5-tool-oracle.mjs";

const step = (name, args, failure) => ({ name, args, failure });

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
  child.stdin.on("error", () => {}); // The exit status/stderr below reports early driver failure.
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
  for (const [index, [path, content]] of Object.entries(files).entries()) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
    // 两边 mtime 完全相同且无并列；不能靠排序结果掩盖 Glob/Grep 的顺序差异。
    const time = new Date(1_700_000_000_000 + index * 10_000);
    await utimes(join(root, path), time, time);
  }
}

function normalize(value, root) {
  if (typeof value === "string") return value.replaceAll(root, "<workspace>");
  if (Array.isArray(value)) return value.map((item) => normalize(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "durationMs")
        .map(([key, item]) => [key, normalize(item, root)]),
    );
  }
  return value;
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

async function differential(files, steps, verifyModel = true) {
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
    for (const [index, { name, args, failure }] of steps.entries()) {
      const label = `${index}: ${name} ${JSON.stringify(args)}`;
      const tsResult = oracle[index];
      const rustResult = rust[index];
      const tsFailed = !tsResult.ok || tsResult.output?.result === false;
      assert.equal(
        tsFailed,
        failure !== undefined,
        `Live TS outcome: ${label}: ${JSON.stringify(tsResult)}`,
      );
      assert.equal(
        rustResult.error !== undefined,
        tsFailed,
        `Rust outcome: ${label}: ${JSON.stringify(rustResult)}`,
      );
      if (tsFailed) {
        const tsMessage = normalize(tsResult.error?.message ?? tsResult.output.message, tsRoot);
        const rustMessage = normalize(rustResult.error, rustRoot);
        if (failure === "exact") assert.equal(rustMessage, tsMessage, label);
        else if (failure instanceof RegExp) {
          assert.match(tsMessage, failure, label);
          assert.match(rustMessage, failure, label);
        }
        continue;
      }
      const expected = normalize(tsResult.output, tsRoot);
      const actual = normalize(rustResult.data, rustRoot);
      // Read 的 IO 统计与 Edit 的匹配诊断为 adapter 扩展，本切片只验收共同输出契约。
      const fields =
        name === "Read"
          ? ["type", "content", "startLine", "numLines", "totalLines", "truncated"]
          : name === "Edit"
            ? [
                "filePath",
                "oldString",
                "newString",
                "originalFile",
                "structuredPatch",
                "userModified",
                "replaceAll",
              ]
            : Object.keys(expected);
      for (const field of fields)
        assert.deepEqual(actual[field], expected[field], `${label}: ${field}`);
      if (verifyModel)
        assert.deepEqual(
          normalize(rustResult.content, rustRoot),
          normalize(tsResult.content, tsRoot),
          `${label}: model text`,
        );
    }
    assert.deepEqual(
      await fileBytes(rustRoot),
      await fileBytes(tsRoot),
      "All final files (including rejected writes) must match byte-for-byte",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("M5 Read: live TS text, paging, BOM/CRLF, empty and missing boundaries", async () => {
  await differential(
    { "sample.txt": "alpha\nbeta\ngamma\n", "crlf.txt": "\ufeffa\r\nb\r\n", "empty.txt": "" },
    [
      step("Read", { file_path: "sample.txt" }),
      step("Read", { file_path: "sample.txt", offset: 2, limit: 1 }),
      step("Read", { file_path: "sample.txt", offset: 50, limit: 1 }),
      step("Read", { file_path: "crlf.txt" }),
      step("Read", { file_path: "empty.txt" }),
      step("Read", { file_path: "missing.txt" }, "exact"),
      step("Read", { file_path: "sample.txt", limit: 0 }, "library"),
    ],
  );
});

test("M5 Edit: read admission, ambiguity, replacement and failure immutability", async () => {
  await differential({ "sample.txt": "alpha\nbeta beta\ngamma\n" }, [
    step(
      "Edit",
      { file_path: "sample.txt", old_string: "alpha", new_string: "A" },
      /File has not been read yet/,
    ),
    step("Read", { file_path: "sample.txt" }),
    step("Edit", { file_path: "sample.txt", old_string: "beta", new_string: "B" }, "exact"),
    step("Edit", { file_path: "sample.txt", old_string: "absent", new_string: "x" }, "exact"),
    step("Edit", {
      file_path: "sample.txt",
      old_string: "beta",
      new_string: "B",
      replace_all: true,
    }),
    step("Edit", { file_path: "sample.txt", old_string: "alpha", new_string: "A" }),
    step("Edit", { file_path: "sample.txt", old_string: "A", new_string: "A" }, "exact"),
    step("Edit", { file_path: "missing.txt", old_string: "x", new_string: "y" }, "exact"),
    step("Edit", { file_path: "nested/new.txt", old_string: "", new_string: "new\n" }),
  ]);
});

test("M5 Write: create parents, overwrite after Read, reject unread overwrite", async () => {
  await differential({ "sample.txt": "original\n" }, [
    step("Write", { file_path: "sample.txt", content: "rejected\n" }, /Read.*(first|before)/),
    step("Read", { file_path: "sample.txt" }),
    step("Write", { file_path: "sample.txt", content: "updated\n" }),
    step("Write", { file_path: "nested/new.txt", content: "created\n" }),
    step("Write", { file_path: "nested/new.txt", content: "second\n" }),
  ]);
});

test("M5 Glob: actual public TS tool, ordered matches, scoped and failed searches", async () => {
  await differential({ "a.txt": "a", "nested/b.txt": "b", "nested/c.js": "c" }, [
    step("Glob", { pattern: "**/*.txt" }),
    step("Glob", { pattern: "*.txt", path: "nested" }),
    step("Glob", { pattern: "**/*.none" }),
    step("Glob", { pattern: "", path: "." }, /pattern must not be empty/),
    step("Glob", { pattern: "*", path: "missing" }, "library"),
  ]);
});

test("M5 Grep: default adapter, file/content/count, filters, pagination and failures", async () => {
  await differential(
    { "a.txt": "alpha\nbeta\nbeta\n", "nested/b.txt": "BETA\ngamma\n", "c.js": "beta\n" },
    [
      step("Grep", { pattern: "beta" }),
      step("Grep", { pattern: "beta", path: "a.txt", output_mode: "content" }),
      step("Grep", { pattern: "beta", path: "a.txt", output_mode: "count" }),
      step("Grep", { pattern: "beta", "-i": true, glob: "**/*.txt" }),
      step("Grep", {
        pattern: "beta",
        path: "a.txt",
        output_mode: "content",
        offset: 1,
        head_limit: 1,
      }),
      step("Grep", { pattern: "no-match" }),
      step("Grep", { pattern: "" }, /pattern must not be empty/),
      step("Grep", { pattern: "[" }, "library"),
      step("Grep", { pattern: "beta", path: "missing" }, "library"),
    ],
  );
});

test("M5 Grep: BOM, CRLF, lone CR and non-UTF-8 line text", async () => {
  await differential(
    {
      "bom.txt": "\ufeffalpha\nalpha\n",
      "crlf.txt": "alpha\r\nbeta\r\n",
      "lonecr.txt": "alpha\rbeta\ngamma\r",
      "invalid.txt": Buffer.from([0x62, 0x65, 0x74, 0x61, 0xff, 0x0a]),
      "invalid-mid.txt": Buffer.from([
        0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a, 0x62, 0x65, 0x74, 0x61, 0xff, 0x0a, 0x67, 0x61, 0x6d,
        0x6d, 0x61, 0x0a,
      ]),
    },
    [
      // ripgrep 剥离文件起始 BOM，`^` 能锚定首行；Read 保留 BOM，两者边界不同。
      step("Grep", { pattern: "^alpha", path: "bom.txt", output_mode: "content" }),
      step("Grep", { pattern: "^alpha", path: "bom.txt", output_mode: "count" }),
      step("Grep", { pattern: "alpha", path: "crlf.txt", output_mode: "content" }),
      step("Grep", { pattern: "beta", path: "lonecr.txt", output_mode: "content" }),
      // 非 UTF-8 行在 ripgrep JSON 只有 bytes 字段，模型文本为空行。
      step("Grep", { pattern: "beta", path: "invalid.txt", output_mode: "content" }),
      step("Grep", { pattern: "beta", path: "invalid-mid.txt", output_mode: "content", "-C": 1 }),
    ],
  );
});

test("M5 Grep: head_limit/offset pagination and model text", async () => {
  await differential(
    { "rev.txt": "beta\nbeta\nbeta\nbeta\nbeta\n", "a.txt": "beta\n", "c.js": "beta\n" },
    [
      step("Grep", { pattern: "beta", path: "rev.txt", output_mode: "content", head_limit: 2 }),
      step("Grep", {
        pattern: "beta",
        path: "rev.txt",
        output_mode: "content",
        head_limit: 2,
        offset: 1,
      }),
      step("Grep", { pattern: "beta", path: "rev.txt", output_mode: "content", offset: 10 }),
      step("Grep", { pattern: "beta", path: "rev.txt", output_mode: "content", head_limit: 0 }),
      // files 模式按 mtime 排序后分页；count 的分页不影响 numFiles/numMatches。
      step("Grep", { pattern: "beta", head_limit: 1 }),
      step("Grep", { pattern: "beta", head_limit: 1, offset: 1 }),
      step("Grep", { pattern: "beta", path: "rev.txt", output_mode: "count", offset: 5 }),
      step("Grep", {
        pattern: "beta",
        path: "rev.txt",
        output_mode: "content",
        head_limit: 2,
        "-C": 1,
      }),
    ],
  );
});

test("M5 Grep: -C/context priority over -B/-A including context=0", async () => {
  await differential({ "ctx.txt": "l1\nl2\nl3\nbeta\nl5\nl6\nl7\n" }, [
    // TS grep.ts 取 contextLines = context ?? -C；adapter 在 contextLines 已定义时只传 -C，
    // 同时给出的 -B/-A 被忽略。
    step("Grep", {
      pattern: "beta",
      path: "ctx.txt",
      output_mode: "content",
      "-C": 1,
      "-B": 2,
      "-A": 3,
    }),
    step("Grep", {
      pattern: "beta",
      path: "ctx.txt",
      output_mode: "content",
      context: 2,
      "-B": 1,
      "-A": 1,
    }),
    // context: 0 是显式值（?? 只跳过 null/undefined），仍只传 -C 0 并忽略 -B/-A。
    step("Grep", {
      pattern: "beta",
      path: "ctx.txt",
      output_mode: "content",
      context: 0,
      "-B": 2,
      "-A": 2,
    }),
    step("Grep", {
      pattern: "beta",
      path: "ctx.txt",
      output_mode: "content",
      "-C": 0,
      "-B": 2,
      "-A": 2,
    }),
    // 没有 context/-C 时才分别使用 -B/-A。
    step("Grep", { pattern: "beta", path: "ctx.txt", output_mode: "content", "-B": 2 }),
    step("Grep", { pattern: "beta", path: "ctx.txt", output_mode: "content", "-A": 2 }),
  ]);
});

test("M5 oracle refuses non-private workspaces, path escapes, symlinks and non-file tools", async () => {
  await assert.rejects(runTsOracle(process.cwd(), []), /private/);
  const root = await mkdtemp(join(tmpdir(), "zcode-rust-m5-tools-"));
  try {
    const cwd = join(root, "ts");
    await mkdir(cwd);
    await writeFile(join(root, "outside.txt"), "private fixture sibling");
    await assert.rejects(
      runTsOracle(cwd, [step("Read", { file_path: "../outside.txt" })]),
      /escapes/,
    );
    await symlink(join(root, "outside.txt"), join(cwd, "link.txt"));
    await assert.rejects(
      runTsOracle(cwd, [step("Read", { file_path: "link.txt" })]),
      /symlink escapes/,
    );
    await assert.rejects(
      runTsOracle(cwd, [step("Bash", { command: "echo must-not-run" })]),
      /Unsupported/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M5 tools: driver timeout kills and awaits a hung subprocess", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], "", 100),
    /driver timed out after 100ms/,
  );
});
