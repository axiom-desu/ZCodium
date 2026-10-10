# Third-party notices

## skills/ — MIT, redistributed from obra/superpowers

The fifteen skills under `skills/` are from:

    obra/superpowers
    https://github.com/obra/superpowers
    Copyright (c) 2025 Jesse Vincent
    MIT License

The upstream work is licensed under the MIT License, which permits use,
copying, modification, merging, publication and distribution on the condition
that the copyright notice and the permission notice are carried along. The full
license text ships in this plugin as `LICENSE` (byte-identical to the
upstream `LICENSE`), and this NOTICE carries the copyright notice and the
source path for every skill, so the attribution travels with the plugin.

Four files additionally carry an inline attribution footer at the end:
`brainstorming/SKILL.md`, `writing-plans/SKILL.md`, `writing-skills/SKILL.md`
and `verification-before-completion/SKILL.md`. The other files rely on
`LICENSE` + this NOTICE; do not describe them as carrying a per-file footer.

The skills are redistributed **unmodified in substance**: the frontmatter,
body and structure are upstream's. The only addition is the footer named above,
on those four files. No upstream content was removed or rewritten.

## 与上游 3.15.1 那份 vendoring 的关系（同步时必读）

zai-org/ZCode 3.15.1 也 vendor 了同一上游，但那是**另一份（更旧的）快照**：14 个技能、
54 个文件，另带 `hooks/**` 与 `copilot-tools.md`。两份快照的文件级对应关系表明我们这份
更新：

| 那份快照的文件 | 我们这份的对应物 |
| --- | --- |
| `subagent-driven-development/code-quality-reviewer-prompt.md` + `spec-reviewer-prompt.md` | `task-reviewer-prompt.md` + `re-review-prompt.md` |
| `test-driven-development/testing-anti-patterns.md` | `writing-good-tests.md` |
| `using-superpowers/references/copilot-tools.md` | `claude-code-tools.md`、`pi-tools.md`、`muse-tools.md`、`hermes-tools.md`、`antigravity-tools.md` |

共同文件也普遍更长（例：`brainstorming/SKILL.md` 比那份多 200 余行，并重写了
"Establish Shared Understanding" 一段）。

所以同步时**不要**用上游那份覆盖本插件——那是降级。要跟上上游时，应直接取
`obra/superpowers` 的当前版本再比对，而 zai-org 的 vendoring 不是事实源。

那份快照的 `hooks/**`（`hooks.json`、`run-hook.cmd`、`session-start`）本插件不引用：
清单没有 `hooks` 键，运行时的 hooks 服务只读用户 / 工作区配置，插件的 `hooks/` 目录不会被
加载。取过来是死资产。

唯一从那份快照补齐的文件是 `writing-skills/testing-skills-with-subagents.md`：我们这份快照的
`writing-skills/SKILL.md` 链接它但没随包，是一处真实的悬空引用；那份快照有这个文件，内容
与本插件的技能一致，因此直接取用而不是删链接。

## Provenance

| skill | upstream path |
| --- | --- |
| brainstorming | `skills/brainstorming/SKILL.md` |
| diagnosing-superpowers | `skills/diagnosing-superpowers/SKILL.md` |
| dispatching-parallel-agents | `skills/dispatching-parallel-agents/SKILL.md` |
| executing-plans | `skills/executing-plans/SKILL.md` |
| finishing-a-development-branch | `skills/finishing-a-development-branch/SKILL.md` |
| receiving-code-review | `skills/receiving-code-review/SKILL.md` |
| requesting-code-review | `skills/requesting-code-review/SKILL.md` |
| subagent-driven-development | `skills/subagent-driven-development/SKILL.md` |
| systematic-debugging | `skills/systematic-debugging/SKILL.md` |
| test-driven-development | `skills/test-driven-development/SKILL.md` |
| using-git-worktrees | `skills/using-git-worktrees/SKILL.md` |
| using-superpowers | `skills/using-superpowers/SKILL.md` |
| verification-before-completion | `skills/verification-before-completion/SKILL.md` |
| writing-plans | `skills/writing-plans/SKILL.md` |
| writing-skills | `skills/writing-skills/SKILL.md` |

`package.json` and `.zcodium-plugin/plugin.json` are original manifests written
for this repository, under the same MIT license as the content they package.
