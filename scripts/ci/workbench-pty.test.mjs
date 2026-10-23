// composer_line 必须只看最末 composer box：transcript 有 Borders::ALL，历史 user/assistant
// 行同样以 `│` 开头；旧实现全屏扫 `│` 会把重启前同一份 gamma 草稿当成当前 editor。
// 本测试把 support.py 当纯模块 import（main 不运行），用构造屏幕验证边界。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const support = resolve(repo, "scripts/lib/zcode-cli-rust-workbench-pty-support.py");

const join = (...lines) => lines.join("\n");

const OLD_TRANSCRIPT = join(
  "┌ ZCodium Rust ───────────────────────────────────┐",
  "│ You                                             │",
  "│ draft gamma notes @docs/gamma.txt               │",
  "│ Assistant                                       │",
  "│ answer: draft gamma notes @docs/gamma.txt       │",
  "└─────────────────────────────────────────────────┘",
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type a prompt                                   │",
  "└─────────────────────────────────────────────────┘",
  " model-a · provider · thought                     ",
);

const CURRENT_COMPOSER = join(
  "┌ ZCodium Rust ───────────────────────────────────┐",
  "│ answer: draft gamma notes @docs/gamma.txt       │",
  "└─────────────────────────────────────────────────┘",
  "┌ Build · 1 attachments ──────────────────────────┐",
  "│ draft gamma notes @docs/gamma.txt               │",
  "└─────────────────────────────────────────────────┘",
);

const MULTILINE_COMPOSER = join(
  "┌ Build · 1 attachments ──────────────────────────┐",
  "│ first line                                      │",
  "│ draft gamma notes @docs/gamma.txt               │",
  "└─────────────────────────────────────────────────┘",
);

// 选择面板可以遮住右侧，因此不能要求右 `│`；但 box 外无 border 的提示行不能算。
const COVERED_RIGHT_BORDER = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ draft gamma notes @docs/ga                      ",
  "└─────────────────────────────────────────────────┘",
);

const BORDERLESS_HINT = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type a prompt                                   │",
  "draft gamma notes @docs/gamma.txt",
  "└─────────────────────────────────────────────────┘",
);

const HINT_OUTSIDE_BOX = join(
  "┌ ZCodium Rust ───────────────────────────────────┐",
  "│ Assistant                                       │",
  "└─────────────────────────────────────────────────┘",
  "draft gamma notes @docs/gamma.txt",
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type a prompt                                   │",
  "└─────────────────────────────────────────────────┘",
);

const EDIT_MODE = join(
  "┌ Edit ───────────────────────────────────────────┐",
  "│ draft gamma notes @docs/gamma.txt               │",
  "└─────────────────────────────────────────────────┘",
);

const YOLO_MODE = join(
  "┌ Yolo ───────────────────────────────────────────┐",
  "│ draft gamma notes @docs/gamma.txt               │",
  "└─────────────────────────────────────────────────┘",
);

const CASES = [
  {
    name: "old transcript gamma is not the current composer",
    screen: OLD_TRANSCRIPT,
    needle: "draft gamma notes",
    expected: false,
  },
  {
    name: "old transcript still exposes the real empty composer",
    screen: OLD_TRANSCRIPT,
    needle: "Type a prompt",
    expected: true,
  },
  {
    name: "current composer gamma is recognised",
    screen: CURRENT_COMPOSER,
    needle: "draft gamma notes",
    expected: true,
  },
  {
    name: "current composer keeps its attachment token visible",
    screen: CURRENT_COMPOSER,
    needle: "@docs/gamma.txt",
    expected: true,
  },
  {
    name: "multi-line composer scans every content row",
    screen: MULTILINE_COMPOSER,
    needle: "draft gamma notes",
    expected: true,
  },
  {
    name: "suggestion may cover the right border without hiding the draft",
    screen: COVERED_RIGHT_BORDER,
    needle: "draft gamma notes @docs/ga",
    expected: true,
  },
  {
    name: "borderless hint row is not composer content",
    screen: BORDERLESS_HINT,
    needle: "draft gamma notes",
    expected: false,
  },
  {
    name: "hint outside the composer box is ignored",
    screen: HINT_OUTSIDE_BOX,
    needle: "draft gamma notes",
    expected: false,
  },
  {
    name: "Edit mode border is a composer",
    screen: EDIT_MODE,
    needle: "draft gamma notes",
    expected: true,
  },
  {
    name: "Yolo mode border is a composer",
    screen: YOLO_MODE,
    needle: "draft gamma notes",
    expected: true,
  },
];

const PROBE = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location(
    "zcode_workbench_pty_support", ${JSON.stringify(support)}
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = json.load(sys.stdin)
print(
    json.dumps(
        {
            case["name"]: module.composer_line(case["screen"], case["needle"])
            for case in cases
        },
        ensure_ascii=False,
    )
)
`;

test("workbench composer_line reads only the bottom composer box", () => {
  const result = spawnSync("python3", ["-c", PROBE], {
    cwd: repo,
    input: JSON.stringify(CASES),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `support probe failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  const actual = JSON.parse(result.stdout);
  for (const entry of CASES) {
    assert.equal(
      actual[entry.name],
      entry.expected,
      `${entry.name}: expected ${entry.expected}, got ${actual[entry.name]}`,
    );
  }
});
