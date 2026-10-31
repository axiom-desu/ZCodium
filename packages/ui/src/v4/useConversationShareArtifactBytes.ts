import { useEffect, useRef, useState } from "react";
import {
  ConversationShareArtifactReadError,
  type ConversationShareArtifactReadErrorKind,
  type ConversationShareArtifactReader,
} from "@zcode/shared";

import {
  ConversationShareArtifactObjectUrlScope,
  readConversationShareArtifactBytes,
} from "@/v4/conversationShareArtifactReader.js";

interface ConversationShareArtifactBytesState {
  status: "idle" | "loading" | "ready" | "error";
  blob: Blob | null;
  objectUrl: string | null;
  errorKind: ConversationShareArtifactReadErrorKind | null;
}

function idleState(): ConversationShareArtifactBytesState {
  return { status: "idle", blob: null, objectUrl: null, errorKind: null };
}

/**
 * 读取一个公开 artifact，并把「当前代次」的 Blob/object URL 交给卡片。
 *
 * 取消、换代与卸载都走同一套 generation：
 * - 旧请求即便晚到，`isCurrent` 为 false 时不会创建 URL 或写 state；
 * - cleanup 只 release 自己那一代，绝不撤销新卡片已经建立的 URL；
 * - 文本读取传 `createObjectUrl: false`，避免为一次性预览多存一份 Blob URL。
 */
export function useConversationShareArtifactBytes(options: {
  url: string | undefined;
  reader: ConversationShareArtifactReader | undefined;
  enabled: boolean;
  createObjectUrl: boolean;
}): ConversationShareArtifactBytesState {
  const { url, reader, enabled, createObjectUrl } = options;
  const [state, setState] = useState<ConversationShareArtifactBytesState>(idleState);
  const scopeRef = useRef<ConversationShareArtifactObjectUrlScope | null>(null);
  if (scopeRef.current === null) scopeRef.current = new ConversationShareArtifactObjectUrlScope();
  const scope = scopeRef.current;

  useEffect(() => {
    const generation = scope.beginGeneration();
    if (!enabled || !url) {
      setState(idleState());
      return () => scope.release(generation);
    }
    setState({ status: "loading", blob: null, objectUrl: null, errorKind: null });
    const controller = new AbortController();
    let alive = true;
    void (async () => {
      try {
        const result = await readConversationShareArtifactBytes(url, reader, {
          signal: controller.signal,
        });
        if (!alive || controller.signal.aborted || !scope.isCurrent(generation)) return;
        const blob = new Blob([result.bytes], {
          type: result.mediaType ?? "application/octet-stream",
        });
        const objectUrl = createObjectUrl ? scope.replace(generation, blob) : null;
        if (!alive || controller.signal.aborted || !scope.isCurrent(generation)) return;
        setState({ status: "ready", blob, objectUrl, errorKind: null });
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        if (!scope.isCurrent(generation)) return;
        setState({
          status: "error",
          blob: null,
          objectUrl: null,
          errorKind:
            error instanceof ConversationShareArtifactReadError ? error.kind : "unavailable",
        });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      scope.release(generation);
    };
  }, [createObjectUrl, enabled, reader, scope, url]);

  return state;
}
