#!/usr/bin/env node
// Real Linux PTY acceptance for the Rust terminal UI; all user state lives under a disposable root.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentText, modelServer } from "./lib/zcode-cli-rust-interop-fixture.mjs";
import {
  TUI_MODELS,
  prepareTuiHome,
  validateTuiModels,
} from "./lib/zcode-cli-rust-tui-fixture.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const binary = resolve(option("--binary", "apps/zcode-cli-rust/target/debug/zcode-cli-rust"));
const keep = args.includes("--keep");
validateTuiModels(TUI_MODELS);
const pastedModel = TUI_MODELS[1];
const downModel = TUI_MODELS[2];
const summaryPrompt = "CRITICAL: Respond with TEXT ONLY";
const summaryHeader = "This session is being continued from a previous conversation";
const root = await mkdtemp(join(tmpdir(), "zcode-rust-tui-"));
let model;
let result;
let success = false;
try {
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "note.txt"), "TUI_NOTE_MARKER\n");
  model = await modelServer({ root, ignoreSystemReminders: true });
  const base = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const env = {
    ...base,
    ...(await prepareTuiHome(root, model.baseUrl)),
    TERM: "xterm-256color",
    ZCODE_RUNTIME_ENV: "production",
  };
  if (args.includes("--provider-discovery")) {
    // 旧测试注入两个路径会掩盖裸 CLI 无法发现 GUI 配置的问题；本场景仅写 canonical 文件。
    const configRoot = join(root, "data", ".zcodium-exp", "v2");
    const builtinRoot = join(configRoot, "runtime", "provider", "bundled");
    await mkdir(builtinRoot, { recursive: true });
    if (!args.includes("--packaged-builtin")) {
      await copyFile(
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
        join(builtinRoot, "zcode-builtin.json"),
      );
    }
    await copyFile(
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
      join(configRoot, "provider_config.json"),
    );
    env.ZCODE_DATA_BASE_DIR = join(root, "data");
    delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    assert.equal(env.ZCODE_AGENT_SERVER_RUNTIME, undefined);
  }
  const python = spawn("python3", [resolve("scripts/lib/zcode-cli-rust-tui-pty.py")], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdout = [];
  python.stdout.setEncoding("utf8");
  python.stdout.on("data", (chunk) => stdout.push(chunk));
  python.stdin.end(
    JSON.stringify({
      binary,
      cwd,
      env,
      root,
      models: TUI_MODELS,
      prefixArgs: args.includes("--desktop") ? ["--cli"] : [],
    }),
  );
  const code = await new Promise((resolveExit, reject) => {
    python.once("error", reject);
    python.once("close", resolveExit);
  });
  result = JSON.parse(stdout.join(""));
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.ok(result.sessionId, "missing real session id from /sessions");
  const requests = model.requests;
  const lastText = (request) => contentText(request.messages.at(-1)?.content);
  const requestWithLastUser = (text) =>
    requests.find((request) => {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      return lastUser !== undefined && contentText(lastUser.content) === text;
    });
  const allText = requests
    .flatMap((request) =>
      request.messages.map((message) => {
        const content = message.content;
        return typeof content === "string"
          ? content
          : (content ?? []).map((part) => part.text ?? "").join("");
      }),
    )
    .join("\n");
  for (const prompt of [
    "first turn",
    "second distinct turn",
    "use tool",
    "tui-write-deny",
    "tui-write-allow",
    "tui-question",
    "slow request",
    "after cancellation",
    "continue history check",
  ])
    assert.ok(allText.includes(prompt), `local model did not receive prompt: ${prompt}`);
  const toolNames = requests.flatMap((request) =>
    request.messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name),
  );
  for (const name of ["Read", "Write", "AskUserQuestion"])
    assert.ok(toolNames.includes(name), `model did not issue real ${name} tool call`);
  // 真实 AskUserQuestion：旧 fixture 传单数 question + 字符串 options，Rust 以参数错误失败，
  // 面板从未出现，SMOKE_ANSWER 退化为普通 prompt。这里逐层锁定工具参数、真实答案关联与请求形态。
  const questionCall = requests
    .flatMap((request) => request.messages.flatMap((message) => message.tool_calls ?? []))
    .find((call) => call.function?.name === "AskUserQuestion");
  assert.ok(questionCall, "model never issued an AskUserQuestion tool call");
  const questionArgs = JSON.parse(questionCall.function.arguments);
  assert.deepEqual(
    Object.keys(questionArgs),
    ["questions"],
    "question tool args must use questions[]",
  );
  assert.equal(questionArgs.questions.length, 1);
  const [askedQuestion] = questionArgs.questions;
  assert.equal(askedQuestion.question, "Choose the TUI smoke answer");
  assert.equal(askedQuestion.header, "TUI smoke");
  assert.equal(askedQuestion.multiSelect, false);
  assert.deepEqual(
    askedQuestion.options.map((option) => option.label),
    ["SMOKE_ANSWER", "SMOKE_ALTERNATE"],
  );
  assert.ok(
    askedQuestion.options.every(
      (option) => typeof option.description === "string" && option.description.trim().length > 0,
    ),
    "question options need real descriptions",
  );
  // 答案必须回到同一 AskUserQuestion 的 tool result；失败结果只包含参数/协议错误文本，
  // OpenAI chat 线上又剥离 `_zcode_tool_failed`，所以真实问答关联就是「非错误」判据。
  const questionToolResult = requests
    .flatMap((request) => request.messages)
    .find((message) => message.role === "tool" && message.tool_call_id === questionCall.id);
  assert.ok(questionToolResult, "AskUserQuestion tool result never returned to the model");
  const questionToolText = contentText(questionToolResult.content);
  assert.ok(
    questionToolText.includes('"Choose the TUI smoke answer"="SMOKE_ANSWER"'),
    `AskUserQuestion tool result did not carry the real answer: ${questionToolText}`,
  );
  assert.ok(
    !requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && contentText(message.content).trim() === "SMOKE_ANSWER",
      ),
    ),
    "SMOKE_ANSWER was submitted as a plain user turn instead of a question answer",
  );
  const questionRequestIndex = requests.findIndex((request) => {
    const last = request.messages.at(-1);
    return last?.role === "tool" && last.tool_call_id === questionCall.id;
  });
  assert.ok(questionRequestIndex >= 0, "question tool result was not replayed to the model");
  const questionFollowUp = requests[questionRequestIndex + 1];
  assert.ok(questionFollowUp, "the question turn never produced a follow-up request");
  assert.ok(
    questionFollowUp.messages.some(
      (message) =>
        message.role === "assistant" &&
        contentText(message.content).trim() === "question answered: SMOKE_ANSWER",
    ),
    "model did not observe the real AskUserQuestion answer",
  );
  assert.equal(await readFile(join(cwd, "allowed.txt"), "utf8"), "TUI_WRITE_MARKER\n");
  assert.equal(
    await readFile(join(cwd, "denied.txt"), "utf8").then(
      () => true,
      () => false,
    ),
    false,
  );

  // 续跑上下文仍需保留 first turn；本批新增 compact 摘要请求会成为最后的请求，
  // 因此把基线断言精确指向 continue 那一轮，而不是放宽成"任意请求出现过"。
  const continued = requestWithLastUser("continue history check");
  assert.ok(continued, "continued session did not send the continue prompt");
  assert.ok(
    continued.messages.some(
      (message) => message.role === "user" && contentText(message.content).includes("first turn"),
    ),
    "continued session lost its prior model context",
  );
  const continuedIndex = requests.indexOf(continued);
  assert.ok(continuedIndex >= 0, "continued request was not recorded");
  // 原 smoke 的 14 请求基线在修正伪问答后是 13：旧 fixture 的工具参数错误还多花了一次
  // 「普通 SMOKE_ANSWER prompt」请求；真实回答进入同一 AskUserQuestion 的 tool result，请求数少 1。
  // 新增的选择器/档位/compact 请求只能落在它之后。
  const baselineRequests = requests.slice(0, continuedIndex + 1);
  const addedRequests = requests.slice(continuedIndex + 1);
  assert.equal(
    baselineRequests.length,
    13,
    `original smoke baseline changed: ${baselineRequests.length} requests before and including continue`,
  );
  assert.ok(
    baselineRequests.every((request) => !lastText(request).includes(summaryPrompt)),
    "compact summary leaked into the original 14-request baseline",
  );

  // 输入补全/Tab 与本地错误只能留在 TUI：除了 Enter 后真实的两次 compact 摘要，
  // 任何本地文本都不应出现在模型请求里。
  for (const local of [
    "compactfoo",
    "Unknown command",
    "alias compact notes",
    "turbo",
    "bogus",
    "模型筛选",
  ])
    assert.ok(!allText.includes(local), `local-only text reached the model: ${local}`);
  for (const localTurn of ["/", "/odel"])
    assert.ok(
      !requests.some((request) =>
        request.messages.some(
          (message) => message.role === "user" && contentText(message.content).trim() === localTurn,
        ),
      ),
      `local completion draft reached the model: ${localTurn}`,
    );
  assert.ok(
    !requests.some((request) =>
      request.messages.some(
        (message) => message.role === "user" && contentText(message.content).trim() === "/compact",
      ),
    ),
    "Tab-completed /compact was submitted without going through Enter",
  );
  assert.ok(
    !requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && contentText(message.content).trim() === "keep these notes",
      ),
    ),
    "compact instructions were submitted as a plain user turn",
  );

  // 两次真实 compact：别名+慢请求产生 running/cancelled，补全+Enter 产生 success；
  // 两者都必须带真实附注并走完整摘要请求，且使用选择器确认的 typed 模型。
  const summaryRequests = requests.filter((request) => lastText(request).includes(summaryPrompt));
  assert.equal(
    summaryRequests.length,
    2,
    `expected exactly two real compact summary requests, got ${summaryRequests.length}`,
  );
  assert.ok(
    summaryRequests.some((request) => lastText(request).includes("slow compact notes")),
    "alias compact summary did not preserve its instructions",
  );
  assert.ok(
    summaryRequests.some((request) => lastText(request).includes("keep these notes")),
    "canonical compact summary did not preserve its instructions",
  );
  assert.ok(
    summaryRequests.every((request) => request.model === downModel.id),
    "compact summary did not use the typed model selected in the picker",
  );
  assert.ok(
    summaryRequests.every((request) => request.messages.length > 1),
    "compact summary request skipped the resumed history",
  );
  assert.ok(
    summaryRequests.every((request) => requests.indexOf(request) > continuedIndex),
    "compact summary ran inside the original baseline",
  );
  // 新增请求不按加数猜：逐个确认 typed/compact 轮次都在 continue 之后，且只出现一次。
  for (const prompt of [
    "typed model check",
    "arrow model check",
    "compact history one",
    "compact history two",
    "after compact",
  ]) {
    const request = requestWithLastUser(prompt);
    assert.ok(request, `new-session prompt was not sent: ${prompt}`);
    assert.ok(
      requests.indexOf(request) > continuedIndex,
      `prompt ran before baseline end: ${prompt}`,
    );
    assert.equal(
      requests.filter((candidate) => lastText(candidate) === prompt).length,
      1,
      `new-session prompt was sent more than once: ${prompt}`,
    );
  }
  assert.equal(
    addedRequests.length,
    7,
    `expected exactly seven requests after the 13-request baseline, got ${addedRequests.length}`,
  );

  // 选择器粘贴/下箭头必须提交真实 typed 模型，而不是按过滤后行号猜。
  assert.equal(requestWithLastUser("typed model check")?.model, pastedModel.id);
  assert.equal(requestWithLastUser("arrow model check")?.model, downModel.id);
  const following = requestWithLastUser("after compact");
  assert.ok(following, "post-compact prompt was not sent");
  const actorSummaries = following.messages.filter(
    (message) => message.role === "user" && contentText(message.content).includes(summaryHeader),
  );
  assert.equal(
    actorSummaries.length,
    1,
    "post-compact request did not carry exactly one actor summary",
  );
  assert.ok(
    contentText(actorSummaries[0].content).includes("keep these notes"),
    "actor summary did not retain the compact instructions",
  );
  for (const dropped of ["compact history one", "compact history two"])
    assert.ok(
      !following.messages.some((message) => contentText(message.content).includes(dropped)),
      `manual compact left pre-compaction history in the next request: ${dropped}`,
    );

  success = true;
  console.log(
    JSON.stringify({
      status: "passed",
      root: keep ? root : undefined,
      providerDiscovery: args.includes("--provider-discovery"),
      packagedBuiltin: args.includes("--packaged-builtin"),
      assertions: result.assertions,
      sessionId: result.sessionId,
      modelRequests: requests.length,
      baselineRequests: baselineRequests.length,
      addedRequests: addedRequests.length,
      compactRequests: summaryRequests.length,
      askUserQuestion: {
        toolCallId: questionCall.id,
        question: askedQuestion.question,
        answer: "SMOKE_ANSWER",
        toolResultAnswered: true,
      },
      typedModels: [pastedModel.id, downModel.id],
      tools: toolNames,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      root,
      keepRoot: true,
      error: String(error),
      stack: error.stack,
      assertions: result?.assertions,
      sessionId: result?.sessionId,
      modelRequests: model?.requests.length,
      requestTail: model?.requests.slice(-6).map((request) => ({
        model: request.model,
        lastRole: request.messages.at(-1)?.role,
        last: contentText(request.messages.at(-1)?.content).slice(0, 160),
        lastTail: contentText(request.messages.at(-1)?.content).slice(-240),
        includesSlow: contentText(request.messages.at(-1)?.content).includes("slow"),
      })),
    }),
  );
  process.exitCode = 1;
} finally {
  if (model) await model.close();
  if (success && !keep) await rm(root, { recursive: true, force: true });
  else console.error(`TUI smoke root retained: ${root}`);
}
