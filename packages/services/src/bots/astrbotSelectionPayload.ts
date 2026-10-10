// AstrBot 桥接的 selection → delivery payload 渲染。见 .agents/specs/bots-astrbot-bridge.md。
//
// 边界：这里只做「传输层渲染」。selection 的业务内容（title / options / action / token）由官方
// BotsService 的 createSelectionReply 产生，本模块不新增、不修改任何业务状态，也不做 IO。
//
// 修复依据：v2.1 之前 astrbotProvider 只把 BotOutboundMessage.text 包成 {type:"text"} 下发，
// message.selection 被整体丢弃；而 BotsService 对非 weixin provider 只把 selection.title 写进
// text。后果是 AstrBot 用户只能看到权限/提问/菜单的标题，看不到选项：
// - resolvePendingSelectionCommand 仅对 weixin 放开「回复数字」的隐式解析；
// - handlePendingElicitationValue 对非微信通道强校验 token，而 token 从未展示给用户。
// 两者叠加使权限与问答在 AstrBot 渠道无法完成。协议侧 shared/src/bots/bridge.ts 一直有完整的
// selection payload schema，插件也已渲染 payload.text，缺的只是这一层渲染。

import type { BotsBridgeDeliveryPayload, Locale, SelectionPrompt } from "@zcode/shared";
import { formatBotMessage } from "./messages.js";

/** 菜单类 action → 用户可发送的命令前缀（与官方 parseBotCommand 对齐）。 */
const SELECTION_ACTION_COMMAND_PREFIX: Partial<Record<SelectionPrompt["action"], string>> = {
  "workspace.set": "/workspace",
  "model.provider.set": "/model provider",
  "model.set": "/model",
  "mode.set": "/mode",
  "thoughtLevel.set": "/thoughtLevel",
  "task.set": "/task",
  "reply.set": "/reply",
};

function toBridgeSelectionKind(
  action: SelectionPrompt["action"],
): "permission" | "elicitation" | "menu" {
  switch (action) {
    case "permission.respond":
      return "permission";
    case "elicitation.respond":
      return "elicitation";
    default:
      return "menu";
  }
}

/**
 * 反解权限 requestId。
 * botsService 构造 permission selection 时把选项 id 写成了完整命令
 * （`/approve <requestId> <optionId>` / `/deny <requestId>`），这里按同一契约反解，
 * 避免为拿一个 requestId 去改动官方共享的 SelectionPrompt 类型。
 * 解析不到时返回 undefined：纯文本插件不消费该字段，canonical 文本仍带完整命令。
 */
function resolvePermissionRequestId(selection: SelectionPrompt): string | undefined {
  for (const option of selection.options) {
    const approve = /^\/approve\s+(\S+)\s+\S+$/u.exec(option.id);
    if (approve?.[1]) {
      return approve[1];
    }
    const deny = /^\/deny\s+(\S+)$/u.exec(option.id);
    if (deny?.[1]) {
      return deny[1];
    }
  }
  return undefined;
}

/** 选项描述与 label 同行展示，保持纯文本渠道的信息密度与飞书卡片一致。 */
function formatOptionLine(index: number, option: SelectionPrompt["options"][number]): string {
  const description = option.description?.trim();
  return description ? `${index}. ${option.label} — ${description}` : `${index}. ${option.label}`;
}

function buildSelectionText(selection: SelectionPrompt, locale?: Locale): string {
  const lines: string[] = [selection.title];

  for (const [index, option] of selection.options.entries()) {
    if (selection.action === "permission.respond") {
      // permission 的 options[].id 本身就是完整命令，直接展示，用户可照抄。
      lines.push(`${formatOptionLine(index + 1, option)} → ${option.id}`);
      continue;
    }
    lines.push(formatOptionLine(index + 1, option));
  }

  // 每个 action 只给一行"怎么回"的提示；取消项自成一行，不再额外重复解释。
  if (selection.action === "permission.respond") {
    // Bugfix: permission 原来复用 selectionTextHint（"回复数字选择，0 取消"），
    // 但权限请求固定 showCancel=false，文案与实际展示的选项自相矛盾。
    // 每个选项行已经带完整命令，这里只说明两种应答方式。
    lines.push(formatBotMessage(locale, "permissionSelectionHint"));
  } else if (selection.action === "elicitation.respond") {
    // 非微信通道强校验 token，必须把命令形式写全；submit 覆盖多选提交。
    const token = selection.token?.trim();
    if (token) {
      lines.push(formatBotMessage(locale, "elicitationReplyHint", { token }));
    }
  } else {
    const commandPrefix = SELECTION_ACTION_COMMAND_PREFIX[selection.action];
    if (commandPrefix) {
      lines.push(formatBotMessage(locale, "selectionCommandHint", { command: commandPrefix }));
    }
  }

  if (selection.showCancel !== false) {
    const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
    lines.push(`0. ${cancelLabel}`);
  }

  return lines.join("\n");
}

/**
 * 把官方 selection 渲染成桥接 delivery payload。
 * 同一条出站带 selection 时只发这一个 payload，不再补发标题文本（见 spec「不得重复发送」）。
 */
export function buildAstrBotSelectionDeliveryPayload(
  selection: SelectionPrompt,
  locale?: Locale,
): BotsBridgeDeliveryPayload {
  const requestId =
    selection.action === "permission.respond" ? resolvePermissionRequestId(selection) : undefined;
  const token = selection.token?.trim();

  return {
    type: "selection",
    selectionId: selection.id,
    title: selection.title,
    text: buildSelectionText(selection, locale),
    options: selection.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    action: selection.action,
    ...(requestId ? { requestId } : {}),
    ...(token ? { token } : {}),
    ...(selection.cancelLabel ? { cancelLabel: selection.cancelLabel } : {}),
    ...(selection.showCancel !== undefined ? { showCancel: selection.showCancel } : {}),
    meta: { kind: toBridgeSelectionKind(selection.action) },
  };
}
