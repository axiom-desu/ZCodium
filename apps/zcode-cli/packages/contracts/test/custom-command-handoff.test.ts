// ============================================================
// F16 自定义命令 `!` shell 块移交：解析只改写文本，不执行 shell
// ============================================================
// 不变式：
//   1. 改写在参数替换之前，参数文本永不被当成 shell 块；
//   2. 块里出现的命令原样保留在 bash 代码块里，由模型的 Bash 调用执行，说明文字写明来源命令文件；
//   3. 命令侧拿不到的变量整块不转交，改写为可读原因，避免审批看到的命令与实际不同；
//   4. 解析没有失败路径：`!` 语法不再抛「unsupported dynamic expansion」。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expandCustomCommandPrompt,
  handOffCustomCommandShellBlocks,
  type CustomCommandContent,
  type CustomCommandMetadata,
} from "../src/index.js";

function command(
  content: string,
  metadata: Partial<CustomCommandMetadata> = {},
): CustomCommandContent {
  const base: CustomCommandMetadata = {
    allowedTools: [],
    description: "test command",
    disableNonInteractive: false,
    frontmatterKeys: [],
    name: "greet",
    path: "/tmp/greet.md",
    rootPath: "/tmp",
    scope: "project",
    skills: [],
    source: "agents",
    ...metadata,
  };
  return { bytesRead: content.length, content, metadata: base, sizeBytes: content.length, truncated: false };
}

describe("handOffCustomCommandShellBlocks", () => {
  it("把行内与 fenced 块改写成 bash 代码块并写明来源", () => {
    const result = handOffCustomCommandShellBlocks(
      "before !`git status`\n```!\ngit log --oneline -3\n```\nafter",
      { metadata: { name: "greet", scope: "project", source: "agents" } },
    );
    assert.ok(result.includes("the /greet command file (project/agents)"));
    assert.ok(result.includes("Run it with the Bash tool exactly as written"));
    assert.ok(result.includes("```bash\ngit status\n```"));
    assert.ok(result.includes("```bash\ngit log --oneline -3\n```"));
    assert.ok(result.includes("before "));
    assert.ok(result.includes("after"));
  });

  it("正文里的感叹号不被当成命令", () => {
    const result = handOffCustomCommandShellBlocks("Warning! this is prose `code`", {
      metadata: { name: "greet", scope: "project", source: "agents" },
    });
    assert.equal(result, "Warning! this is prose `code`");
  });

  it("插件变量就地解析，Windows 路径改正斜杠", () => {
    const result = handOffCustomCommandShellBlocks("```!\nbash ${CLAUDE_PLUGIN_ROOT}/run.sh\n```", {
      metadata: {
        name: "greet",
        plugin: {
          dataPath: "C:\\data\\plugin",
          id: "p1",
          name: "Plugin",
          rootPath: "C:\\root\\plugin",
        },
        scope: "user",
        source: "plugin",
      },
    });
    assert.ok(result.includes("bash C:/root/plugin/run.sh"));
  });

  it("命令拿不到的变量整块不转交", () => {
    const result = handOffCustomCommandShellBlocks("!`ls ${CLAUDE_SKILL_DIR}`", {
      metadata: { name: "greet", scope: "project", source: "agents" },
    });
    assert.ok(result.includes("was not run: it uses ${CLAUDE_SKILL_DIR}"));
    assert.ok(!result.includes("```bash"));
  });

  it("空块被删除", () => {
    assert.equal(
      handOffCustomCommandShellBlocks("a ```!   ``` b", {
        metadata: { name: "greet", scope: "project", source: "agents" },
      }),
      "a  b",
    );
  });
});

describe("expandCustomCommandPrompt", () => {
  it("改写早于参数替换：参数里的反引号不会被当成 shell 块", () => {
    const expanded = expandCustomCommandPrompt({
      args: "!`rm -rf /`",
      command: command("run $ARGUMENTS now"),
    });
    // 参数文本原样进入正文，没有被 hand-off 改成 bash 代码块指令。
    assert.ok(expanded.prompt.includes("run !`rm -rf /` now"));
    assert.ok(!expanded.prompt.includes("Run it with the Bash tool exactly as written"));
  });

  it("`!` 块不再抛 unsupported 错误，交给模型 Bash", () => {
    const expanded = expandCustomCommandPrompt({
      args: "",
      command: command("```!\necho hi\n```"),
    });
    assert.ok(expanded.prompt.includes("```bash\necho hi\n```"));
    assert.ok(expanded.prompt.includes("Command source: project/agents."));
  });

  it("$ARGUMENTS 替换与未使用参数的追加保持不变", () => {
    const withArgs = expandCustomCommandPrompt({
      args: "a b",
      command: command("body"),
    });
    assert.ok(withArgs.prompt.includes("User arguments:\na b"));
    assert.equal(withArgs.usedArgumentsPlaceholder, false);
  });
});
