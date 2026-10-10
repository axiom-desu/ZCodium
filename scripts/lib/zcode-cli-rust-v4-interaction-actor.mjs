/** Owns one-shot V4 interaction answers for the interop driver. */
export function createV4InteractionActor({ answer, onError = () => {} }) {
  const claimed = new Set();

  function claim(interactionId, sessionId, toolName) {
    if (!interactionId || !sessionId || claimed.has(interactionId)) return false;
    claimed.add(interactionId);
    Promise.resolve()
      .then(() => answer(sessionId, interactionId, toolName))
      .catch((error) => onError(error));
    return true;
  }

  function observe(interactions, sessionId) {
    for (const interaction of interactions ?? []) {
      if (
        interaction?.kind === "permission" &&
        ["Bash", "Read"].includes(interaction.payload?.toolName)
      ) {
        claim(interaction.interactionId, sessionId, interaction.payload.toolName);
      }
    }
  }

  function observeFrame(frame) {
    const payload = frame?.params?.frame?.payload ?? frame?.params ?? {};
    const topic = frame?.params?.frame?.topic ?? frame?.params?.topic;
    const sessionId =
      payload.sessionId ??
      payload.snapshot?.sessionId ??
      (typeof topic === "string" && topic.startsWith("conversation/")
        ? topic.slice("conversation/".length)
        : undefined);
    if (!sessionId) return;
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (Array.isArray(value.pendingInteractions)) observe(value.pendingInteractions, sessionId);
      for (const child of Object.values(value)) visit(child);
    };
    visit(payload);
  }

  return {
    claim,
    observe,
    observeFrame,
    hasClaimed: (interactionId) => claimed.has(interactionId),
  };
}
