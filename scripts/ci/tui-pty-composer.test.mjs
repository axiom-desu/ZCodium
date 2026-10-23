// baseline TUI PTY 探针：composer 必须只看最末 box，pending 文案必须与 Rust 源一致。
// Python 模块按纯模块 import，`main` 不会运行；测试不启动 TUI，也不发模型请求。
// 依赖 actor 的命令（/queue pause|delete|up|send|resume、/queue list）必须按因果结算：
// 先看到草稿真的进了 bottom composer，Enter 后必须同时满足「composer 清空」与
// 「对应在飞提示消失」，否则命令会拼进上一条被拒的草稿（PR88 CI 失败形态）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = resolve(repo, "scripts/lib/zcode-cli-rust-tui-pty.py");
const support = resolve(repo, "scripts/lib/zcode-cli-rust-workbench-pty-support.py");
const projection = resolve(repo, "apps/zcode-cli-rust/crates/tui/src/projection.rs");
// 只有这两个文件发送依赖 actor 的输入；driver 源码本身也在这里守住因果顺序。
const ACTOR_DRIVERS = [
  "scripts/lib/zcode-cli-rust-workbench-pty.py",
  "scripts/lib/zcode-cli-rust-responsive-queue.py",
];

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

// 忙轮下 placeholder 是 `Type to queue input`（presentation.rs），只认 `Type a prompt`
// 会把整个 busy 队列场景当成永不清空；反之也不能把草稿当成清空。
const BUSY_IDLE = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type to queue input                             │",
  "└─────────────────────────────────────────────────┘",
  "Queued 3 · Enter send · Alt/Shift+Enter newline · Ctrl-X,B sidebar · /help",
);

// 队列 mutation 已提交（composer 已清空）但 ACK/快照仍在飞：不能算结算。
const QUEUE_IN_FLIGHT = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ Type to queue input                             │",
  "└─────────────────────────────────────────────────┘",
  "Saving queue change... · Enter send · /help",
);

// Enter 之前的瞬间：composer 里还有草稿，命令肯定尚未被消费。
const TYPED_COMMAND = join(
  "┌ Build ──────────────────────────────────────────┐",
  "│ /queue pause                                    │",
  "└─────────────────────────────────────────────────┘",
  "Enter send · /help",
);

const PROBE = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("zcode_tui_baseline_pty", ${JSON.stringify(baseline)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
# 依赖 actor 的命令只看 workbench support（responsive 也复用它），不能各写一份。
support_spec = importlib.util.spec_from_file_location(
    "zcode_workbench_pty_support", ${JSON.stringify(support)}
)
support = importlib.util.module_from_spec(support_spec)
support_spec.loader.exec_module(support)
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
    "support_labels": list(support.PENDING_LABELS),
    "support_idle": {
        name: support.composer_idle(payload["screens"][name])
        for name in ["busy", "in_flight", "typed", "pending", "old"]
    },
    "support_settled": {
        name: support.settled(payload["screens"][name])
        for name in ["busy", "in_flight", "typed", "pending", "old"]
    },
}, ensure_ascii=False))
`;

// 按脚本推进帧的假会话：wait_until 只在后续帧真的满足条件时返回，帧耗尽即 deadline。
// 它让“只看 submit 前的空闲帧就放行”这种退化在测试里必顶（真 PTY 里那条帧确实存在）。
const CAUSALITY_PROBE = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location(
    "zcode_workbench_pty_support", ${JSON.stringify(support)}
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.load(sys.stdin)


class ScriptedSession:
    def __init__(self, frames):
        self.frames = frames
        self.index = 0
        self.writes = []

    def screen(self):
        return self.frames[min(self.index, len(self.frames) - 1)]

    def send(self, text):
        self.writes.append([text, self.index])

    def wait_until(self, predicate, label, timeout=25):
        while True:
            if predicate(self.frames[self.index]):
                return self.frames[self.index]
            if self.index + 1 >= len(self.frames):
                raise TimeoutError(f"deadline waiting for {label}")
            self.index += 1


out = {}
for case in payload["cases"]:
    session = ScriptedSession([payload["frames"][name] for name in case["frames"]])
    try:
        module.run_actor_command(session, payload["command"], case["name"])
        out[case["name"]] = {"writes": session.writes, "index": session.index}
    except TimeoutError as error:
        out[case["name"]] = {
            "writes": session.writes,
            "index": session.index,
            "timeout": str(error),
        }
print(json.dumps(out, ensure_ascii=False))
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
      screens: {
        busy: BUSY_IDLE,
        in_flight: QUEUE_IN_FLIGHT,
        typed: TYPED_COMMAND,
        pending: PENDING_SCREEN,
        old: OLD_TRANSCRIPT,
      },
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
  // 复用基线唯一权威，不在 support 里再维护一份 pending 文案表。
  assert.deepEqual(
    actual.support_labels,
    actual.labels,
    "workbench support must reuse the baseline pending-label authority",
  );
});

test("workbench settle probe needs a clean bottom composer AND no in-flight label", async () => {
  const result = spawnSync("python3", ["-c", PROBE], {
    cwd: repo,
    input: JSON.stringify({
      cases: CASES,
      old: OLD_TRANSCRIPT,
      current: CURRENT_COMPOSER,
      pending: PENDING_SCREEN,
      idle: CURRENT_COMPOSER,
      screens: {
        busy: BUSY_IDLE,
        in_flight: QUEUE_IN_FLIGHT,
        typed: TYPED_COMMAND,
        pending: PENDING_SCREEN,
        old: OLD_TRANSCRIPT,
      },
    }),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `settle probe failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  const actual = JSON.parse(result.stdout);
  // busy 轮里的 placeholder 也是真的空 editor。
  assert.deepEqual(actual.support_idle, {
    busy: true,
    in_flight: true,
    typed: false,
    pending: true,
    old: true,
  });
  // 只有「composer 清空 + 在飞提示消失」同时成立才算结算。
  assert.deepEqual(actual.support_settled, {
    busy: true,
    in_flight: false,
    typed: false,
    pending: false,
    old: true,
  });
});

test("run_actor_command sends Enter only after the draft and waits for the label to clear", () => {
  const result = spawnSync("python3", ["-c", CAUSALITY_PROBE], {
    cwd: repo,
    input: JSON.stringify({
      command: "/queue pause",
      frames: { pre: BUSY_IDLE, draft: TYPED_COMMAND, flight: QUEUE_IN_FLIGHT, settled: BUSY_IDLE },
      cases: [
        // submit 前的空闲帧 -> 草稿可见 -> 已清空但在飞 -> 结算
        { name: "settled", frames: ["pre", "draft", "flight", "settled"] },
        // 回显从未出现（命令未被消费）：旧空闲帧不能被当成结算
        { name: "never-typed", frames: ["pre"] },
        // 已提交但在飞提示不消失：清空的 composer 不足以放行下一条
        { name: "still-in-flight", frames: ["pre", "draft", "flight"] },
      ],
    }),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `causality probe failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  const actual = JSON.parse(result.stdout);
  // Enter 必须发生在草稿帧之后；返回时必须已经越过在飞帧（index 3 才是真结算）。
  assert.deepEqual(actual.settled, {
    writes: [
      ["/queue pause", 0],
      ["\r", 1],
    ],
    index: 3,
  });
  assert.deepEqual(actual["never-typed"].writes, [["/queue pause", 0]]);
  assert.match(actual["never-typed"].timeout, /deadline/);
  assert.deepEqual(actual["still-in-flight"].writes, [
    ["/queue pause", 0],
    ["\r", 1],
  ]);
  assert.match(actual["still-in-flight"].timeout, /deadline/);
});

test("actor-dependent /queue commands are never typed behind another keystroke", async () => {
  // PR88 回归形态：`send("/queue pause\\r")` 后再 `send("/queue list\\r")`，
  // 第二条 Enter 落在仍被拒的稿里，三条命令拼成一行。
  const dependent = /session\.send\(\s*f?["']\/queue\b/;
  for (const file of ACTOR_DRIVERS) {
    const source = await readFile(resolve(repo, file), "utf8");
    let previous = "";
    const offenders = [];
    source.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (!code || code.startsWith("#")) return;
      if (dependent.test(code) && previous.startsWith("session.send(")) {
        offenders.push(`${file}:${index + 1}: ${code}`);
      }
      previous = code;
    });
    assert.deepEqual(
      offenders,
      [],
      `dependent /queue command sent before the previous keystroke settled: ${offenders.join(" | ")}`,
    );
  }
});
