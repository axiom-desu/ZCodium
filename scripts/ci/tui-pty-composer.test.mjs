// baseline TUI PTY 探针：composer 必须只看最末 box，pending 文案必须与 Rust 源一致。
// Python 模块按纯模块 import，`main` 不会运行；测试不启动 TUI，也不发模型请求。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = resolve(repo, "scripts/lib/zcode-cli-rust-tui-pty.py");
const projection = resolve(repo, "apps/zcode-cli-rust/crates/tui/src/projection.rs");

const join = (...lines) => lines.join("\n");

// 旧 transcript 已包含同名 `/new` 草稿；bottom composer 才是唯一可提交 editor。
const OLD_TRANSCRIPT = join(
  "┌ ZCodium Rust ───────────────────────────────────┐",
  "│ /new                                            │",
  "│ Type a prompt                                   │",
  "│ Assistant                                       │",
  "│ answer: old transcript                          │",
  "└─────────────────────────────────────────────────┘",
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type a prompt                                   │",
  "└─────────────────────────────────────────────────┘",
  " model-a · provider · thought                     ",
);

const CURRENT_COMPOSER = join(
  "┌ ZCodium Rust ───────────────────────────────────┐",
  "│ Assistant                                       │",
  "│ answer: old transcript                          │",
  "└─────────────────────────────────────────────────┘",
  "┌ Build ──────────────────────────────────────────┐",
  "│ /new                                            │",
  "└─────────────────────────────────────────────────┘",
);

const PENDING_SCREEN = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type a prompt                                   │",
  "└─────────────────────────────────────────────────┘",
  "Opening session... · Enter send · /help",
);

const CASES = [
  {
    name: "old transcript /new is not the current composer",
    screen: OLD_TRANSCRIPT,
    needle: "/new",
    expected: false,
  },
  {
    name: "old transcript cannot make the current composer empty",
    screen: OLD_TRANSCRIPT,
    needle: "Type a prompt",
    expected: true,
  },
  {
    name: "current bottom composer sees /new",
    screen: CURRENT_COMPOSER,
    needle: "/new",
    expected: true,
  },
];

const PROBE = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("zcode_tui_baseline_pty", ${JSON.stringify(baseline)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.load(sys.stdin)
print(json.dumps({
    "cases": {
        case["name"]: module.composer_line(case["screen"], case["needle"])
        for case in payload["cases"]
    },
    "old_empty": module.composer_empty(payload["old"]),
    "current_empty": module.composer_empty(payload["current"]),
    "pending": module.pending_visible(payload["pending"]),
    "idle_pending": module.pending_visible(payload["idle"]),
    "labels": list(module.PENDING_LABELS),
}, ensure_ascii=False))
`;

test("baseline TUI composer and pending probes keep old transcript out", async () => {
  const source = await readFile(projection, "utf8");
  // projection.rs 是 pending 文案的唯一 owner；Python 只镜像英文话术，不能自己猜。
  const rustLabels = [...source.matchAll(/\(Self::\w+, false\) => "([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(rustLabels.length >= 6, "projection.rs pending labels were not found");

  const result = spawnSync("python3", ["-c", PROBE], {
    cwd: repo,
    input: JSON.stringify({
      cases: CASES,
      old: OLD_TRANSCRIPT,
      current: CURRENT_COMPOSER,
      pending: PENDING_SCREEN,
      idle: CURRENT_COMPOSER,
    }),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `baseline probe failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  const actual = JSON.parse(result.stdout);
  for (const entry of CASES) {
    assert.equal(
      actual.cases[entry.name],
      entry.expected,
      `${entry.name}: expected ${entry.expected}, got ${actual.cases[entry.name]}`,
    );
  }
  // 因果 guard：只有 bottom placeholder 才能证明 editor 清空；
  // 旧 transcript 里的 `Type a prompt` 不能把当前带草稿的 composer 判成空闲。
  assert.equal(actual.old_empty, true);
  assert.equal(actual.current_empty, false);
  assert.equal(actual.pending, true);
  assert.equal(actual.idle_pending, false);
  assert.deepEqual(
    [...new Set(rustLabels)].sort(),
    [...actual.labels].sort(),
    "Python pending labels drifted from projection.rs",
  );
});
