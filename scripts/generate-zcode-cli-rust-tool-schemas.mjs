// Run with node --import tsx. Every generated asset is projected from current CLI TS contracts.
import { readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";
import { askUserQuestionToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/ask-user-question.ts";
import { skillToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/skill.ts";
import { createAgentToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/agent.ts";
import { sendMessageToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/send-message.ts";
import { webFetchToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/webfetch.ts";
import { webSearchToolEntry } from "../apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts";
import { normalizeAgentProfiles } from "../apps/zcode-cli/packages/core/src/subagent/profile.ts";
import { buildExploreAgentPrompt } from "../apps/zcode-cli/packages/core/src/subagent/explore.ts";
import { buildSubagentCommonNotes } from "../apps/zcode-cli/packages/core/src/subagent/system-prompt.ts";
import { buildPersistentAgentMemoryPrompt } from "../apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts";
import {
  todoReadToolEntry,
  todoWriteToolEntry,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/todo.ts";

const toolSchemas = [
  ["Agent", "agent", "AgentInputJsonSchema"],
  ["SendMessage", "send-message", "SendMessageInputJsonSchema"],
  ["Skill", "skill", "SkillInputJsonSchema"],
  ["TodoRead", "todo", "TodoReadInputJsonSchema"],
  ["TodoWrite", "todo", "TodoWriteInputJsonSchema"],
  ["Read", "read", "ReadInputJsonSchema"],
  ["ReadPdf", "read", "ReadPdfInputJsonSchema"],
  ["Write", "write", "WriteInputJsonSchema"],
  ["Edit", "edit", "EditInputJsonSchema"],
  ["Glob", "glob", "GlobInputJsonSchema"],
  ["Grep", "grep", "GrepInputJsonSchema"],
  ["Bash", "bash", "BashInputJsonSchema"],
  ["TaskOutput", "task-output", "TaskOutputInputJsonSchema"],
  ["TaskStop", "task-stop", "TaskStopInputJsonSchema"],
  ["AskUserQuestion", "ask-user-question", "AskUserQuestionInputJsonSchema"],
  ["WebFetch", "webfetch", "WebFetchInputJsonSchema"],
  ["WebSearch", "websearch", "WebSearchInputJsonSchema"],
];
const schemas = {};
for (const [name, file, key] of toolSchemas) {
  schemas[name] = (await import(`../apps/zcode-cli/packages/contracts/src/tools/${file}.ts`))[key];
}
const assets = [
  [
    "tools",
    "agent_memory_templates.json",
    Object.fromEntries(
      ["user", "project", "local"].map((scope) => [
        scope,
        buildPersistentAgentMemoryPrompt({
          rootDir: "{memoryRoot}",
          indexContent: "{memoryIndex}",
          scope,
        }),
      ]),
    ),
  ],
  [
    "domain",
    "agent_profiles.json",
    normalizeAgentProfiles([]).map((profile) => ({
      ...profile,
      systemPrompt:
        (profile.name === "Explore" ? buildExploreAgentPrompt({}) : profile.systemPrompt) +
        "\n\n" +
        buildSubagentCommonNotes(),
    })),
  ],
  [
    "tools",
    "agent_descriptions.json",
    {
      Agent: createAgentToolEntry({ dynamicWorkflowEnabled: false }).metadata.description,
      SendMessage: sendMessageToolEntry.metadata.description,
    },
  ],
  ["tools", "tool_schemas.json", schemas],
  ["tools", "skill_description.json", skillToolEntry.metadata.description],
  [
    "tools",
    "todo_descriptions.json",
    {
      TodoRead: todoReadToolEntry.metadata.description,
      TodoWrite: todoWriteToolEntry.metadata.description,
    },
  ],
  ["tools", "question_description.json", askUserQuestionToolEntry.metadata.description],
  [
    "tools",
    "web_descriptions.json",
    {
      WebFetch: webFetchToolEntry.metadata.description,
      WebSearch: webSearchToolEntry.metadata.description.replace(
        /The current month is .+? —/u,
        "The current month is {currentMonth} —",
      ),
    },
  ],
];
for (const [directory, name, data] of assets) {
  const path = new URL(`../apps/zcode-cli-rust/crates/${directory}/src/${name}`, import.meta.url);
  const formatted = await format(path.pathname, `${JSON.stringify(data, null, 2)}\n`);
  if (formatted.errors.length) throw new Error(`Cannot format Rust tool asset: ${name}`);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== formatted.code)
      throw new Error(`Rust tool asset differs from TS: ${name}`);
  } else await writeFile(path, formatted.code);
}
