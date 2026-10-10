/** Return true only when this session's current turn streamed non-empty assistant text. */
export function hasAssistantTextEvidence(frames, from, sessionId) {
  const assistantRows = new Map();
  for (const frame of frames.slice(from)) {
    const outer = frame?.params?.frame;
    const payload = outer?.payload;
    const topicSession =
      typeof outer?.topic === "string" && outer.topic.startsWith("conversation/")
        ? outer.topic.slice("conversation/".length)
        : undefined;
    if (!payload || (payload.sessionId ?? topicSession) !== sessionId) continue;
    for (const delta of payload.deltas ?? []) {
      const row = delta.row;
      if (
        (delta.op === "row.appended" || delta.op === "row.upserted") &&
        row?.kind === "assistantText"
      ) {
        assistantRows.set(row.rowId, row.turnId);
        if (typeof row.text === "string" && row.text.length > 0) return true;
        continue;
      }
      if (
        delta.op === "row.delta" &&
        delta.path === "text" &&
        typeof delta.append === "string" &&
        delta.append.length > 0 &&
        assistantRows.has(delta.rowId)
      )
        return true;
    }
  }
  return false;
}
