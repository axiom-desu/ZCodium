// 环境公告（上游 3.18.2）：system 的 # Environment 被 prompt 快照冻结后，变化只能靠增量公告。
// 这里只测纯函数（快照比较、正文、解析），真实 SQLite 冷恢复在 bootstrap 集成测试里。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvInfoBody,
  buildEnvironmentAnnouncement,
  environmentSnapshot,
  parseEnvironmentAnnouncement,
  type EnvironmentSnapshot,
} from "../src/context/sections/env-info.js";
import type { EnvInfo } from "../src/context/types.js";

const envInfo: EnvInfo = {
  cwd: "/work/main",
  platform: "linux",
  shell: "bash",
  osVersion: "linux",
  isGitRepository: false,
  gitStatus: "not_repo",
};

function snapshot(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    ...environmentSnapshot(envInfo, ["/work/shared"]),
    ...overrides,
  };
}

test("首个环境块带 untrusted downloads 说明，且不包含 Desktop 段", () => {
  const content = buildEnvInfoBody(snapshot());
  assert.match(content, /untrusted data/u);
  assert.match(content, /Run any Python that reads them with `-I`/u);
  assert.doesNotMatch(content, /ZCode Desktop Context/u);
});

test("Desktop 会话的环境块带 Desktop 段正文（与 system 渲染同一份措辞）", () => {
  const content = buildEnvInfoBody(
    snapshot({ desktopContext: true, visualizationDirectory: "/tmp/gen-ui/session" }),
  );
  assert.match(content, /# ZCode Desktop Context/u);
  assert.match(content, /Writable, durable visualization directory for this session/u);
});

test("没有基线时不重发正文：调用方只记录基线", () => {
  const announcement = buildEnvironmentAnnouncement(snapshot(), undefined, false);
  assert.ok(announcement);
  assert.equal(announcement.environment.full, true);
  // 正文本身是完整环境块；是否写入对话历史由 runtime 决定（system 已有一份）。
  assert.match(announcement.content, /^# Environment\n/u);
});

test("附加目录增删只追加 difference 行，不重发整块", () => {
  const previous = snapshot();
  const next = snapshot({ additionalWorkingDirectories: ["/work/shared", "/work/added"] });
  const announcement = buildEnvironmentAnnouncement(next, previous, true);
  assert.ok(announcement);
  assert.equal(announcement.environment.full, false);
  assert.match(announcement.content, /^# Environment update/u);
  assert.match(announcement.content, /Additional working directories added:\n {2}- \/work\/added/u);
  assert.doesNotMatch(announcement.content, /# Environment\n/u);
  assert.doesNotMatch(announcement.content, /Primary working directory/u);

  const removed = buildEnvironmentAnnouncement(
    snapshot({ additionalWorkingDirectories: [] }),
    previous,
    true,
  );
  assert.ok(removed);
  assert.match(
    removed.content,
    /Additional working directories removed:\n {2}- \/work\/shared/u,
  );
});

test("shell / cwd / git 变化各写一行并带旧值", () => {
  const announcement = buildEnvironmentAnnouncement(
    snapshot({ cwd: "/work/moved", shell: "zsh", isGitRepository: true }),
    snapshot(),
    true,
  );
  assert.ok(announcement);
  assert.match(announcement.content, /Primary working directory: \/work\/moved \(was \/work\/main\)/u);
  assert.match(announcement.content, /Shell: zsh \(was bash\)/u);
  assert.match(announcement.content, /Is a git repository: yes \(was no\)/u);
});

test("Desktop 写法变化追加整段；离开 Desktop 追加一句不再适用", () => {
  const desktop = snapshot({ desktopContext: true, visualizationDirectory: "/tmp/gen-ui/s" });
  const entered = buildEnvironmentAnnouncement(desktop, snapshot(), true);
  assert.ok(entered);
  assert.match(entered.content, /# ZCode Desktop Context/u);
  const left = buildEnvironmentAnnouncement(snapshot(), desktop, true);
  assert.ok(left);
  assert.match(
    left.content,
    /The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop\./u,
  );
});

test("没有变化不产生公告；platform/OS 变化整段重发", () => {
  assert.equal(buildEnvironmentAnnouncement(snapshot(), snapshot(), true), null);
  const platform = buildEnvironmentAnnouncement(snapshot({ platform: "darwin" }), snapshot(), true);
  assert.ok(platform);
  assert.equal(platform.environment.full, true);
  assert.match(platform.content, /^# Environment\n/u);
});

test("公告快照解析：可往返；损坏数据按没有基线处理", () => {
  const announcement = { full: true, snapshot: snapshot({ desktopContext: true }) };
  assert.deepEqual(parseEnvironmentAnnouncement(announcement), announcement);
  assert.equal(parseEnvironmentAnnouncement({ full: true }), undefined);
  assert.equal(parseEnvironmentAnnouncement({ full: "yes", snapshot: snapshot() }), undefined);
  assert.equal(
    parseEnvironmentAnnouncement({ full: true, snapshot: { ...snapshot(), cwd: 1 } }),
    undefined,
  );
});
