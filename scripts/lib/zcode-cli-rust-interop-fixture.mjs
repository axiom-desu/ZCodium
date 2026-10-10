import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const TITLE = "Generate a concise title for this coding session.";

/** The text of a chat message content (string or parts). */
export function contentText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/**
 * A local Chat Completions model: `use tool` asks for `Read note.txt`, `slow` streams one
 * chunk and stalls, `shell` runs a long Bash command; tool results and other prompts get
 * `answer: <prompt>`. Title sidecar requests are answered apart from `requests`.
 */
export async function modelServer({ root }) {
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
    const last = parsed.messages.at(-1);
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
    if (last?.role === "tool") return send({ content: "tool done" }, "stop");
    if (text.includes("use tool")) return call("Read", { file_path: "note.txt" });
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
