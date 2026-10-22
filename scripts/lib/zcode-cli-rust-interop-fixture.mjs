import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const TITLE = "Generate a concise title for this coding session.";
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
/** Rust domain 的 `QuestionInput::answer` 成功文案固定前缀。 */
const ANSWER_PREFIX = "User has answered your questions:";

/** The text of a chat message content (string or parts). */
export function contentText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/**
 * AskUserQuestion 的真实调用参数：schema 只接受 `questions` 数组，每项必须带
 * question/header/multiSelect 与 2-4 个 {label, description} 选项。旧 fixture 传单数
 * `question` + 字符串 `options`，Rust 直接以参数错误失败，待回答面板根本没出现，
 * SMOKE_ANSWER 只能退化成一个普通 prompt。选项固定两条，让面板在 6 行帮助区里
 * 完整显示问题、两个选项和问答页脚，探针才能确认交互真实挂起。
 */
function askUserQuestionArgs() {
  return {
    questions: [
      {
        question: "Choose the TUI smoke answer",
        header: "TUI smoke",
        multiSelect: false,
        options: [
          { label: "SMOKE_ANSWER", description: "Use the scripted first answer." },
          { label: "SMOKE_ALTERNATE", description: "Use the alternate scripted answer." },
        ],
      },
    ],
  };
}

/**
 * AskUserQuestion 的成功结果由 Rust domain 的 `QuestionInput::answer` 生成：
 * `User has answered your questions: "<question>"="<answer>". ...`。按 tool_call_id 找回
 * 原始调用参数，再用问题文本精确匹配答案；参数/协议错误文本与别的工具结果都不可能命中。
 * OpenAI chat 线上会剥离 `_zcode_tool_failed`，所以这个真实关联就是「非错误」判据。
 */
function askUserQuestionAnswer(messages, toolMessage) {
  const text = contentText(toolMessage.content);
  // domain 只在这个前缀下输出答案；错误文本或别的工具输出里即使带 "q"="a" 也不算作答。
  if (!text.startsWith(ANSWER_PREFIX)) return undefined;
  for (const message of messages) {
    for (const entry of message.tool_calls ?? []) {
      if (entry.id !== toolMessage.tool_call_id) continue;
      if (entry.function?.name !== ASK_USER_QUESTION_TOOL) continue;
      let args;
      try {
        args = JSON.parse(entry.function.arguments ?? "");
      } catch {
        return undefined;
      }
      for (const question of Array.isArray(args?.questions) ? args.questions : []) {
        const prefix = `"${question?.question}"="`;
        const start = text.indexOf(prefix);
        if (start < 0) continue;
        const end = text.indexOf('"', start + prefix.length);
        if (end < 0) continue;
        const answer = text.slice(start + prefix.length, end).trim();
        if (answer) return answer;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * A local Chat Completions model: `use tool` asks for `Read note.txt`, `slow` streams one
 * chunk and stalls, `shell` runs a long Bash command; tool results and other prompts get
 * `answer: <prompt>`. Title sidecar requests are answered apart from `requests`.
 */
export async function modelServer({ root, ignoreSystemReminders = false }) {
  const requests = [];
  const slowChunkSignals = new Map();
  let shellPidFile;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish) => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      if (finish)
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
        );
    };
    if (body.includes(TITLE)) return send({ content: '{"title":"Interop"}' }, "stop");
    requests.push(parsed);
    // TUI 菜单/恢复会注入真实控制提醒；echo fixture 应识别最后一条业务消息，
    // 否则把提醒当用户输入会重复工具或跳过 slow 分支。请求记录仍保留完整原始协议。
    const messages = ignoreSystemReminders
      ? parsed.messages.filter(
          (message) =>
            message.role !== "user" ||
            !contentText(message.content).trimStart().startsWith("<system-reminder>"),
        )
      : parsed.messages;
    const last = messages.at(-1);
    const text = contentText(last?.content);
    const call = (name, args) =>
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${randomUUID().slice(0, 8)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    // 只有拿到同一 AskUserQuestion 调用的真实回答才算问答完成；旧 `tool done` 文本既可能是
    // 工具参数错误的结果，也可能是别的工具，不能当作 AskUserQuestion 的完成信号。
    if (last?.role === "tool") {
      const answer = askUserQuestionAnswer(messages, last);
      if (answer) return send({ content: `question answered: ${answer}` }, "stop");
      const asksQuestion = messages.some((message) =>
        (message.tool_calls ?? []).some(
          (entry) =>
            entry.id === last.tool_call_id && entry.function?.name === ASK_USER_QUESTION_TOOL,
        ),
      );
      return send(
        {
          content: asksQuestion
            ? "question unanswered: missing real AskUserQuestion answer"
            : "tool done",
        },
        "stop",
      );
    }
    if (text.includes("use tool")) return call("Read", { file_path: "note.txt" });
    if (text.startsWith("tui-write-allow"))
      return call("Write", { file_path: "allowed.txt", content: "TUI_WRITE_MARKER\n" });
    if (text.startsWith("tui-write-deny"))
      return call("Write", { file_path: "denied.txt", content: "TUI_DENIED_MARKER\n" });
    if (text.startsWith("tui-question")) return call(ASK_USER_QUESTION_TOOL, askUserQuestionArgs());
    if (text.includes("shell")) {
      if (!shellPidFile || !resolve(shellPidFile).startsWith(`${resolve(root)}/`))
        throw new Error(
          "shell fixture requires a configured absolute pidfile inside the temporary test root",
        );
      return call("Bash", {
        command: `printf '%s\\n' "$$" > '${resolve(shellPidFile)}'; sleep 30`,
      });
    }
    if (text.includes("slow")) {
      const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "partial " } }] })}\n\n`;
      response.write(chunk, (error) => {
        if (error) return;
        slowChunkSignals.set(text, (slowChunkSignals.get(text) ?? 0) + 1);
      });
      return; // 保持连接直到进程被杀。
    }
    send({ content: `answer: ${text}` }, "stop");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    slowChunkCount(text) {
      return slowChunkSignals.get(text) ?? 0;
    },
    async waitForSlowChunk(text, previousCount, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((slowChunkSignals.get(text) ?? 0) > previousCount) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      throw new Error(`model server did not flush first slow chunk for request: ${text}`);
    },
    setShellPidFile(path) {
      const absolute = resolve(path);
      if (!absolute.startsWith(`${resolve(root)}/`))
        throw new Error("shell fixture pidfile must remain inside the temporary test root");
      shellPidFile = absolute;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolveClose, reject) => {
        const timer = setTimeout(
          () => reject(new Error("model server close deadline exceeded")),
          5_000,
        );
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolveClose();
        });
      });
    },
  };
}

/**
 * The shared temporary HOME and Provider Registry with the local model
 * (`api` is the provider API type, `properties` the model properties).
 */
export async function prepareHome(
  root,
  baseUrl,
  { api = "openai-chat-completions", properties = { contextWindow: 256000 } } = {},
) {
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const builtin = JSON.parse(await readFile(resolve("config/provider/zcode-builtin.json"), "utf8"));
  builtin.config.providerConfigRules.providerRules = [];
  const personal = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "personal:fixture",
            providerName: "Fixture",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-only" },
              api: { type: api, baseUrl },
              personalModelIds: ["model-a"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: "personal:fixture",
            modelId: "model-a",
            config: {
              properties,
              optionSpecs: { reasoningLevel: { values: ["none"], map: "{}" } },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: "personal:fixture",
        modelId: "model-a",
        options: { reasoningLevel: "none" },
      },
    },
  };
  await writeFile(join(root, "builtin.json"), JSON.stringify(builtin));
  await writeFile(join(root, "personal.json"), JSON.stringify(personal));
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ZCODE_STORAGE_DIR: join(root, "storage"),
    ZCODE_SESSION_DB_PATH: join(root, "db.sqlite"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, "builtin.json"),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, "personal.json"),
  };
  return env;
}

/** The conversation a model request carried: user/assistant/tool entries as text. */
export function transcript(request) {
  return request.messages
    .filter((m) => m.role !== "system")
    .flatMap((m) => {
      const text = contentText(m.content);
      if (m.role === "user" && text.trimStart().startsWith("<system-reminder>")) return [];
      if (m.role === "tool") return [`tool:${m.tool_call_id ? "result" : ""}`];
      const calls = (m.tool_calls ?? []).map((c) => `call:${c.function?.name}`);
      return [...(text ? [`${m.role}:${text}`] : []), ...calls];
    });
}
