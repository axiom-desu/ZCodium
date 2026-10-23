import {
  optionalNumber,
  optionalString,
  removeUndefined,
  jsonObject,
  jsonText,
} from "./restore-values.mjs";

function messageContent(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content === undefined || message.content === null
      ? ""
      : String(message.content);
}

export function messageCompletedAt(message, messageTimestamp) {
  return typeof message.timestamp === "number"
    ? message.timestamp + (optionalNumber(message.durationMs) ?? 0)
    : messageTimestamp;
}

function legacyToolName(tool) {
  const raw = jsonObject(tool.raw);
  const meta = jsonObject(raw._meta);
  const claudeCode = jsonObject(meta.claudeCode);
  return (
    optionalString(claudeCode.toolName) ||
    optionalString(tool.toolName) ||
    optionalString(tool.name) ||
    optionalString(tool.kind) ||
    optionalString(tool.title) ||
    "legacy_tool"
  );
}

function legacyToolTitle(tool, toolName) {
  return optionalString(tool.title) || toolName;
}

function legacyToolCallId(messageId, toolIndex, tool) {
  return (
    optionalString(tool.id) ||
    optionalString(tool.callID) ||
    optionalString(tool.callId) ||
    `call_legacy_${messageId}_${toolIndex}`
  );
}

function legacyToolMetadata(tool) {
  return removeUndefined({
    legacyRestore: true,
    legacyKind: optionalString(tool.kind),
    legacyStatus: optionalString(tool.status),
  });
}

function buildToolPartData(tool, messageId, toolIndex, messageTimestamp, completedAt) {
  const toolName = legacyToolName(tool);
  const input = jsonObject(tool.input);
  const metadata = legacyToolMetadata(tool);
  const status = optionalString(tool.status) || "completed";
  const startedAt = optionalNumber(tool.startedAt) ?? messageTimestamp;
  const endedAt = optionalNumber(tool.completedAt) ?? completedAt;
  let state;

  // Bugfix: CLI session-store 持久化的是 contracts 形状，tool 时间必须放在 state.time。
  // 如果直接写 protocol 的 startedAt/completedAt，app-server 映射 session/read 时会读不到 state.time 而失败。
  if (status === "running") {
    state = {
      status: "running",
      input,
      title: legacyToolTitle(tool, toolName),
      metadata,
      time: { start: startedAt },
    };
  } else if (status === "pending") {
    state = {
      status: "pending",
      input,
      raw: jsonText(tool.raw || tool),
    };
  } else if (status === "failed" || status === "error" || status === "denied") {
    state = {
      status: "error",
      input,
      error: jsonText(tool.error || tool.output || status),
      metadata,
      time: { start: startedAt, end: endedAt },
    };
  } else {
    state = {
      status: "completed",
      input,
      output: jsonText(tool.output),
      title: legacyToolTitle(tool, toolName),
      metadata,
      time: { start: startedAt, end: endedAt },
    };
  }

  return {
    type: "tool",
    callID: legacyToolCallId(messageId, toolIndex, tool),
    tool: toolName,
    state,
  };
}

function buildTextPartData(text, messageTimestamp, completedAt) {
  return {
    type: "text",
    text,
    time: {
      start: messageTimestamp,
      end: completedAt,
    },
  };
}

function buildReasoningPartData(text, messageTimestamp, completedAt) {
  return {
    type: "reasoning",
    text,
    time: {
      start: messageTimestamp,
      end: completedAt,
    },
  };
}

export function buildPartDataList(message, messageId, messageTimestamp) {
  const content = messageContent(message);
  const completedAt = messageCompletedAt(message, messageTimestamp);
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const persistedParts = Array.isArray(message.parts) ? message.parts : [];
  const partDataList = [];

  if (message.role === "assistant" && persistedParts.length > 0) {
    for (const part of persistedParts) {
      if (part?.type === "content" && typeof part.content === "string" && part.content.length > 0) {
        partDataList.push(buildTextPartData(part.content, messageTimestamp, completedAt));
      } else if (
        part?.type === "thought" &&
        typeof part.content === "string" &&
        part.content.length > 0
      ) {
        partDataList.push(buildReasoningPartData(part.content, messageTimestamp, completedAt));
      } else if (part?.type === "tool-call" && Number.isInteger(part.toolIndex)) {
        const tool = tools[part.toolIndex];
        if (tool) {
          partDataList.push(
            buildToolPartData(tool, messageId, part.toolIndex, messageTimestamp, completedAt),
          );
        }
      }
    }
  } else {
    const thought = optionalString(message.thought);
    if (message.role === "assistant" && thought) {
      partDataList.push(buildReasoningPartData(thought, messageTimestamp, completedAt));
    }
    if (content.length > 0) {
      partDataList.push(buildTextPartData(content, messageTimestamp, completedAt));
    }
    for (const [toolIndex, tool] of tools.entries()) {
      partDataList.push(
        buildToolPartData(tool, messageId, toolIndex, messageTimestamp, completedAt),
      );
    }
  }

  const hasVisibleText = partDataList.some(
    (part) => (part.type === "text" || part.type === "reasoning") && part.text.length > 0,
  );
  if (!hasVisibleText && content.length > 0) {
    partDataList.push(buildTextPartData(content, messageTimestamp, completedAt));
  }
  return partDataList;
}
