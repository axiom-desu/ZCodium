import { useEffect, useMemo, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useMobileWebViewport } from "@/hooks/useMobileWebViewport.js";
import { useInputPrediction } from "@/hooks/useInputPrediction.js";

/** Composer-specific capability gate and service-port assembly for temporary input hints. */
export function useComposerInputPrediction({
  disabled,
  draft,
  remoteSessionId,
  revisionFallback,
  sessionId,
  snapshot,
  workspaceIdentity,
  workspacePath,
}: {
  disabled: boolean;
  draft: string;
  remoteSessionId?: string | null;
  revisionFallback: number;
  sessionId?: string | null;
  snapshot: ConversationSnapshot | null;
  workspaceIdentity?: string | null;
  workspacePath: string;
}): ReturnType<typeof useInputPrediction> {
  const services = useOptionalServices();
  const isMobileViewport = useMobileWebViewport();
  const [predictionCapability, setPredictionCapability] = useState(false);
  useEffect(() => {
    let live = true;
    if (!services || !isMobileViewport || !sessionId) {
      setPredictionCapability(false);
      return;
    }
    void services.zcodeAgentService
      .helloConversationV4()
      .then((hello) => {
        if (live) setPredictionCapability(hello.capabilities?.inputPrediction === true);
      })
      .catch(() => {
        if (live) setPredictionCapability(false);
      });
    return () => {
      live = false;
    };
  }, [isMobileViewport, services, sessionId]);

  const predictionPort = useMemo(() => {
    if (!services) return null;
    return {
      predict: (request: {
        sessionId: string;
        revision: number;
        draft: string;
        requestId: string;
      }) =>
        services.zcodeAgentService.conversationInputPredictionV4({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...request,
        }),
      cancel: (request: { sessionId: string; requestId: string }) =>
        services.zcodeAgentService.cancelConversationInputPredictionV4({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...request,
        }),
    };
  }, [remoteSessionId, services, workspaceIdentity, workspacePath]);

  return useInputPrediction({
    port: predictionPort,
    sessionId: sessionId ?? null,
    revision: snapshot?.revision ?? revisionFallback,
    draft,
    enabled: isMobileViewport && predictionCapability,
    active: Boolean(sessionId && snapshot && !snapshot.control.canStop && !disabled),
  });
}
