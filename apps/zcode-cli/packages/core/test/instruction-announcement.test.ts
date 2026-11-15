import assert from "node:assert/strict";
import { it } from "node:test";

import {
  createInstructionFile,
  INSTRUCTION_TYPE_PROJECT,
  INSTRUCTION_TYPE_USER,
  INSTRUCTIONS_PREAMBLE,
  parseInstructionAnnouncement,
  parseLegacyInstructionFiles,
  renderInstructionAnnouncement,
  renderInstructionDelta,
} from "../src/context/sections/instruction-files.js";
import {
  announcedInstructionFilesFromHistory,
  buildInstructionDeltaEntry,
  seedInstructionAnnouncementFromHistory,
} from "../src/runtime/helpers/instruction-announcement.js";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

// 上游 3.18.2 F1 的纯规则：区块形状、增量文案、旧标题行解析与已公告集合推导。
// 真实 runtime 的公告/冷恢复/compaction 场景见 bootstrap/test/upstream-318-context-sync.test.ts。

const project = createInstructionFile("/repo/AGENTS.md", INSTRUCTION_TYPE_PROJECT, "be brief\n");
const user = createInstructionFile("/home/u/AGENTS.md", INSTRUCTION_TYPE_USER, "be kind\n");

it("区块是 preamble + Contents of <path> (<type>): + trim 后正文", () => {
  const text = renderInstructionAnnouncement([project, user]);
  assert.ok(text.startsWith(INSTRUCTIONS_PREAMBLE));
  assert.match(text, /Contents of \/repo\/AGENTS\.md \(project instructions, checked into the codebase\):\n\nbe brief/u);
  assert.match(
    text,
    /Contents of \/home\/u\/AGENTS\.md \(user's private global instructions for all projects\):\n\nbe kind/u,
  );
  // 正文 trim 后取 hash：同一内容带不同空白不算变化。
  assert.equal(createInstructionFile("/x", INSTRUCTION_TYPE_PROJECT, " a \n").hash, createInstructionFile("/x", INSTRUCTION_TYPE_PROJECT, "a").hash);
});

it("增量公告：变化块共用一句说明，删除单独一段", () => {
  const text = renderInstructionDelta([project], ["/repo/OLD.md"], "compaction");
  assert.match(text, /Instruction files were re-read after the conversation was compacted/u);
  assert.match(text, /differ from their earlier copies/u);
  assert.match(text, /Contents of \/repo\/AGENTS\.md/u);
  assert.match(text, /Instructions no longer present: \/repo\/OLD\.md/u);
  assert.ok(!renderInstructionDelta([], ["/repo/OLD.md"], "session_start").includes("differ"));
});

it("公告解析只接受合法 shape", () => {
  assert.deepEqual(parseInstructionAnnouncement({ files: [] }), { files: [] });
  assert.equal(parseInstructionAnnouncement({ files: [{ hash: "h", path: "p" }] }), undefined);
  assert.equal(parseInstructionAnnouncement({ files: [], reason: "other" }), undefined);
  assert.equal(parseInstructionAnnouncement(null), undefined);
  assert.deepEqual(parseInstructionAnnouncement({
    files: [{ hash: "h", path: "p", type: "t" }],
    reason: "compaction",
    removed: ["/gone"],
  }), { files: [{ hash: "h", path: "p", type: "t" }], reason: "compaction", removed: ["/gone"] });
});

it("旧公告按标题行拆出文件（新文案与 3.17 旧文案都认）", () => {
  const content = [
    "Codebase and user instructions are shown below.",
    "",
    "Contents of /repo/AGENTS.md (project instructions, checked into the codebase):",
    "",
    "v1",
    "",
    "Contents of /home/u/AGENTS.md (user default instructions):",
    "",
    "v2",
  ].join("\n");
  const files = parseLegacyInstructionFiles(content);
  assert.deepEqual(
    files.map((file) => [file.path, file.type]),
    [
      ["/repo/AGENTS.md", INSTRUCTION_TYPE_PROJECT],
      ["/home/u/AGENTS.md", "user default instructions"],
    ],
  );
  assert.equal(files[0]!.hash, createInstructionFile("/repo/AGENTS.md", INSTRUCTION_TYPE_PROJECT, "v1").hash);
});

it("已公告集合从最后一条完整公告起套用增量", () => {
  const entries = [
    systemReminderAttachmentEntry("context_prefix", renderInstructionAnnouncement([project, user])),
    systemReminderAttachmentEntry("context_prefix", renderInstructionDelta([project], ["/home/u/AGENTS.md"], "session_start")),
    systemReminderAttachmentEntry("skills_listing", "skills"),
  ];
  const files = announcedInstructionFilesFromHistory(entries);
  assert.deepEqual([...(files?.keys() ?? [])], ["/repo/AGENTS.md"]);
});

function fakeRuntime(files: ReturnType<typeof createInstructionFile>[]): AgentRuntimeInternal {
  return {
    sessionStore: {},
    latestContextBuildResult: {
      metaUserAttachments: [{ source: "context_prefix", content: "rendered", files }],
      sections: [
        {
          source: "request_user_context",
          content: renderInstructionAnnouncement(files),
          instructionFiles: files,
        },
      ],
    },
  } as unknown as AgentRuntimeInternal;
}

it("只有内容或文件集合变化时才追加增量，否则不公告", () => {
  const runtime = fakeRuntime([project, user]);
  runtime.instructionAnnouncement = {
    content: renderInstructionAnnouncement([project, user]),
    files: [project, user].map((file) => ({ hash: file.hash, path: file.path, type: file.type })),
  };
  assert.equal(buildInstructionDeltaEntry(runtime, "session_start"), undefined);

  // 内容变化：增量带新正文与 hash 事实。
  const changed = createInstructionFile("/repo/AGENTS.md", INSTRUCTION_TYPE_PROJECT, "be terse");
  runtime.latestContextBuildResult = fakeRuntime([changed, user]).latestContextBuildResult;
  const delta = buildInstructionDeltaEntry(runtime, "compaction");
  assert.ok(delta && delta.kind === "attachment");
  assert.match(delta.content, /be terse/u);
  assert.doesNotMatch(delta.content, /be kind/u);
  assert.equal(delta.metadata.source, "context_prefix");
  assert.equal(delta.metadata.instructions?.reason, "compaction");
  assert.deepEqual(delta.metadata.instructions?.files.map((file) => file.path), ["/repo/AGENTS.md"]);

  // 文件删除：先按增量更新已公告集合，再只报删除，不重发剩余正文。
  runtime.instructionAnnouncement = {
    content: renderInstructionAnnouncement([project, user]),
    files: [changed, user].map((file) => ({ hash: file.hash, path: file.path, type: file.type })),
  };
  runtime.latestContextBuildResult = fakeRuntime([changed]).latestContextBuildResult;
  const removal = buildInstructionDeltaEntry(runtime, "session_start");
  assert.match(removal?.kind === "attachment" ? removal.content : "", /Instructions no longer present: \/home\/u\/AGENTS\.md/u);
  assert.doesNotMatch(removal?.kind === "attachment" ? removal.content : "", /be terse/u);
});

it("旧会话：状态缺失时用历史已公告集合补一份，之后只发增量", () => {
  const entries = [systemReminderAttachmentEntry("context_prefix", renderInstructionAnnouncement([project]))];
  const runtime = fakeRuntime([project, user]);
  assert.equal(seedInstructionAnnouncementFromHistory(runtime, entries), true);
  assert.deepEqual(
    runtime.instructionAnnouncement?.files.map((file) => file.path),
    ["/repo/AGENTS.md"],
  );
  // 补完状态后，新增文件才发增量。
  const delta = buildInstructionDeltaEntry(runtime, "session_start");
  assert.match(delta?.kind === "attachment" ? delta.content : "", /\/home\/u\/AGENTS\.md/u);
  // 已有状态时不覆盖。
  assert.equal(seedInstructionAnnouncementFromHistory(runtime, entries), false);
});
