// AstrBot 桥接 selection 下发契约。见 .agents/specs/bots-astrbot-bridge.md「selection 下发契约」。
//
// 回归背景：astrbotProvider 曾只把 BotOutboundMessage.text 包成 {type:"text"} 下发，message.selection
// 被丢弃；而 BotsService 对非 weixin provider 只把 selection.title 写进 text，导致 AstrBot 用户
// 看不到权限/提问/菜单的选项，交互无法完成。这里同时钉住 payload 形状与 canonical 文本内容。

import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { createAstrBotBotProvider } = await tsImport(
  "../../packages/services/src/bots/providers/astrbotProvider.ts",
  import.meta.url,
);
const { buildAstrBotSelectionDeliveryPayload } = await tsImport(
  "../../packages/services/src/bots/astrbotSelectionPayload.ts",
  import.meta.url,
);

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function createProvider() {
  let seq = 0;
  return createAstrBotBotProvider({
    logger: silentLogger,
    clock: () => 1_700_000_000_000,
    idFactory: () => `id-${++seq}`,
  });
}

function beginPromptTurn(provider, options = {}) {
  const frame = {
    v: 2,
    kind: "command",
    id: "cmd-1",
    commandId: "cmd-1",
    actor: {
      channel: "astrbot",
      externalUserId: options.externalUserId ?? "lark:u1",
      chatType: options.chatType ?? "private",
      ...(options.chatId ? { chatId: options.chatId } : {}),
    },
    command: { type: "prompt", text: "帮我看一下" },
  };
  return provider.beginTurn(frame, "bot-1");
}

const permissionSelection = {
  id: "permission-req-1",
  title: "是否允许执行命令？",
  action: "permission.respond",
  showCancel: false,
  options: [
    { id: "/approve req-1 allow", label: "允许", description: "本次允许" },
    { id: "/approve req-1 always", label: "始终允许" },
    { id: "/deny req-1", label: "拒绝" },
  ],
};

const elicitationSelection = {
  id: "elicitation-req-1-0",
  title: "1/2 请选择部署环境",
  action: "elicitation.respond",
  token: "abcdef123456",
  options: [
    { id: "staging", label: "预发" },
    { id: "prod", label: "生产" },
  ],
};

const workspaceSelection = {
  id: "workspace-menu",
  title: "选择 workspace",
  action: "workspace.set",
  options: [
    { id: "ws-1", label: "repo-a" },
    { id: "ws-2", label: "repo-b" },
  ],
};

test("permission selection 下发 selection payload，含序号选项、对应命令与 requestId", () => {
  const payload = buildAstrBotSelectionDeliveryPayload(permissionSelection, "zh-CN");

  assert.equal(payload.type, "selection");
  assert.equal(payload.selectionId, "permission-req-1");
  assert.equal(payload.title, "是否允许执行命令？");
  assert.equal(payload.action, "permission.respond");
  assert.equal(payload.requestId, "req-1");
  assert.equal(payload.meta.kind, "permission");
  assert.deepEqual(
    payload.options.map((option) => option.id),
    ["/approve req-1 allow", "/approve req-1 always", "/deny req-1"],
  );

  // canonical 文本必须让人知道回什么：序号 + 标签 + 命令。
  assert.match(payload.text, /是否允许执行命令？/u);
  assert.match(payload.text, /1\. 允许 — 本次允许 → \/approve req-1 allow/u);
  assert.match(payload.text, /2\. 始终允许 → \/approve req-1 always/u);
  assert.match(payload.text, /3\. 拒绝 → \/deny req-1/u);
  // showCancel=false 时不展示取消项。
  assert.doesNotMatch(payload.text, /^0\./mu);
});

test("elicitation selection 带 token，canonical 文本给出 /elicitation <token> <序号>", () => {
  const payload = buildAstrBotSelectionDeliveryPayload(elicitationSelection, "zh-CN");

  assert.equal(payload.type, "selection");
  assert.equal(payload.token, "abcdef123456");
  assert.equal(payload.meta.kind, "elicitation");
  assert.equal(payload.requestId, undefined);
  assert.match(payload.text, /1\/2 请选择部署环境/u);
  assert.match(payload.text, /1\. 预发/u);
  assert.match(payload.text, /2\. 生产/u);
  // 非微信通道强校验 token，canonical 文本必须把命令形式写全。
  assert.match(payload.text, /\/elicitation abcdef123456 <序号>/u);
});

test("菜单类 selection 也下发选项与对应命令前缀", () => {
  const payload = buildAstrBotSelectionDeliveryPayload(workspaceSelection, "zh-CN");

  assert.equal(payload.meta.kind, "menu");
  assert.match(payload.text, /1\. repo-a/u);
  assert.match(payload.text, /2\. repo-b/u);
  assert.match(payload.text, /\/workspace <序号>/u);
  assert.match(payload.text, /^0\. 取消$/mu);
});

test("英文 locale 只本地化提示行，选项 label 原样透传", () => {
  // label/description 是 BotsService 的业务内容（真实流程由 formatBotPermissionOptionLabel 本地化），
  // 传输层渲染器不得改写，只负责本地化自己产生的提示行。
  const payload = buildAstrBotSelectionDeliveryPayload(permissionSelection, "en-US");
  assert.match(payload.text, /^1\. 允许 — 本次允许 → \/approve req-1 allow$/mu);
  assert.match(payload.text, /Reply with \/permission <number>, or send the command above\./u);
  // showCancel=false 时不出现取消项，也不得出现 "0 to cancel" 这类文案。
  assert.doesNotMatch(payload.text, /0 to cancel/u);

  const menuPayload = buildAstrBotSelectionDeliveryPayload(workspaceSelection, "en-US");
  assert.match(menuPayload.text, /Reply with \/workspace <number> to choose\./u);
  assert.match(menuPayload.text, /^0\. Cancel$/mu);
  // 每个 action 只给一行提示，不得再叠加 "回复 0 取消" 之类的重复解释。
  assert.doesNotMatch(menuPayload.text, /Reply with 0 to cancel\./u);

  const elicitationPayload = buildAstrBotSelectionDeliveryPayload(elicitationSelection, "en-US");
  assert.match(
    elicitationPayload.text,
    /Reply with \/elicitation abcdef123456 <number>; send submit when a multi-select is done\./u,
  );
});

test("provider.send 带 selection 时只发一条 selection delivery，不重复发标题文本", async () => {
  const provider = createProvider();
  const frames = [];
  provider.attachTransport({ send: (frame) => frames.push(frame) });

  const bindingId = beginPromptTurn(provider);
  await provider.send(
    {},
    {
      botId: "bot-1",
      provider: "astrbot",
      providerUserId: "lark:u1",
      // BotsService 对非 weixin provider 只把 title 写进 text。
      text: permissionSelection.title,
      selection: permissionSelection,
    },
  );
  provider.settleTurn(bindingId);

  const deliveries = frames.filter((frame) => frame.kind === "delivery");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].payload.type, "selection");
  assert.equal(deliveries[0].payload.requestId, "req-1");
  assert.equal(deliveries[0].seq, 1);

  // 无 selection 的出站保持原有 text 行为。
  await provider.send(
    {},
    {
      botId: "bot-1",
      provider: "astrbot",
      providerUserId: "lark:u1",
      text: "普通回复",
    },
  );
  const textDeliveries = frames.filter(
    (frame) => frame.kind === "delivery" && frame.payload.type === "text",
  );
  assert.equal(textDeliveries.length, 1);
  assert.equal(textDeliveries[0].payload.text, "普通回复");
  assert.equal(textDeliveries[0].seq, 2);

  provider.dispose();
});

test("selection delivery 与 text delivery 共用 seq/回放窗口", async () => {
  const provider = createProvider();
  const frames = [];
  provider.attachTransport({ send: (frame) => frames.push(frame) });

  const bindingId = beginPromptTurn(provider);
  await provider.send(
    {},
    {
      botId: "bot-1",
      provider: "astrbot",
      providerUserId: "lark:u1",
      text: permissionSelection.title,
      selection: permissionSelection,
    },
  );
  await provider.send(
    {},
    { botId: "bot-1", provider: "astrbot", providerUserId: "lark:u1", text: "已允许" },
  );
  provider.settleTurn(bindingId);

  const replay = provider.resolveResume([{ bindingId, seq: 1 }]);
  const replayed = replay.get(bindingId);
  assert.equal(replayed.needsSnapshot, false);
  assert.equal(replayed.frames.length, 1);
  assert.equal(replayed.frames[0].payload.type, "text");

  // 超窗时补投窗口内全部帧；snapshot 保留最近一条（此处最后一条是 text）。
  const stale = provider.resolveResume([{ bindingId, seq: 0 }]);
  assert.equal(stale.get(bindingId).frames.length, 2);
  const snapshot = await provider.buildSnapshot(bindingId);
  assert.equal(snapshot.payload.type, "text");
  assert.equal(snapshot.payload.text, "已允许");

  provider.dispose();
});

test("群聊按 chatId 路由，selection 也能到达同一绑定", async () => {
  const provider = createProvider();
  const frames = [];
  provider.attachTransport({ send: (frame) => frames.push(frame) });

  const bindingId = beginPromptTurn(provider, { chatType: "group", chatId: "lark:group-1" });
  await provider.send(
    {},
    {
      botId: "bot-1",
      provider: "astrbot",
      // BotsService 的 createOutbound 用 chatId 作为 providerUserId。
      providerUserId: "lark:group-1",
      text: permissionSelection.title,
      selection: permissionSelection,
    },
  );

  const deliveries = frames.filter((frame) => frame.kind === "delivery");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].bindingId, bindingId);
  assert.equal(deliveries[0].payload.type, "selection");

  provider.dispose();
});
