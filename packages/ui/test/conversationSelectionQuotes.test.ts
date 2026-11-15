// 选区引用的发送前锚点准入：跨会话与 stale 行必须拒绝，markdown 选区（无会话锚点）放行。
import { describe, expect, it } from "vitest";

import {
  admitConversationSelectionQuotes,
  buildAnnotatedConversationSelection,
  clearConversationSelectionReferenceScope,
  CONVERSATION_SELECTION_MAX_COMMENT_LENGTH,
  getConversationSelectionReferenceScope,
  mergeRowConversationSelections,
  parsePromptConversationSelections,
  setConversationSelectionReferenceScope,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";
import { serializeComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";

function messageReference(
  overrides: Partial<ConversationSelectionReference> = {},
): ConversationSelectionReference {
  return {
    contentType: "assistant",
    id: "ref-message-1",
    sourceRowId: 7,
    sourceSessionId: "session-a",
    text: "await load(); await load();",
    ...overrides,
  } as ConversationSelectionReference;
}

const markdownReference: ConversationSelectionReference = {
  contentType: "markdown",
  id: "ref-markdown-1",
  sourceKey: "docs/spec.md",
  sourceTitle: "Spec",
  text: "quoted spec line",
};

describe("admitConversationSelectionQuotes", () => {
  it("同会话且锚点仍在新窗口里：转成线格式引用并带上批注/agent/path", () => {
    const result = admitConversationSelectionQuotes({
      liveRowIds: new Set([7]),
      references: [
        messageReference({
          agent: "explore",
          comment: "为什么 await 两次？",
          path: "src/loader.ts",
        }),
      ],
      targetSessionId: "session-a",
    });
    expect(result).toEqual({
      ok: true,
      quotes: [
        {
          agent: "explore",
          comment: "为什么 await 两次？",
          path: "src/loader.ts",
          text: "await load(); await load();",
        },
      ],
    });
  });

  it("跨会话引用拒绝（引用原文属于另一个会话的历史）", () => {
    expect(
      admitConversationSelectionQuotes({
        liveRowIds: new Set([7]),
        references: [messageReference({ sourceSessionId: "session-b" })],
        targetSessionId: "session-a",
      }),
    ).toEqual({ ok: false, reason: "crossSession" });
  });

  it("stale 行锚点拒绝（rewind 后行已不在投影窗口）", () => {
    expect(
      admitConversationSelectionQuotes({
        liveRowIds: new Set([8, 9]),
        references: [messageReference({ sourceRowId: 7 })],
        targetSessionId: "session-a",
      }),
    ).toEqual({ ok: false, reason: "staleAnchor" });
  });

  it("投影还没到时只做跨会话判定，不把未知行当 stale", () => {
    expect(
      admitConversationSelectionQuotes({
        liveRowIds: new Set(),
        references: [messageReference({ sourceRowId: 7 })],
        targetSessionId: "session-a",
      }).ok,
    ).toBe(true);
  });

  it("markdown 选区没有会话锚点，跨会话/行检查都不适用", () => {
    const result = admitConversationSelectionQuotes({
      liveRowIds: new Set([1]),
      references: [markdownReference],
      targetSessionId: "session-a",
    });
    expect(result).toEqual({ ok: true, quotes: [{ text: "quoted spec line" }] });
  });

  it("空批注不会写进武器化字段（只保留非空 comment）", () => {
    const result = admitConversationSelectionQuotes({
      liveRowIds: new Set([7]),
      references: [messageReference({ comment: "   " })],
      targetSessionId: "session-a",
    });
    expect(result).toEqual({ ok: true, quotes: [{ text: "await load(); await load();" }] });
  });
});

describe("引用不再拼进正文，历史行从 metadata 还原", () => {
  it("序列化器不再接受选区参数：正文永远不含 userselect 尾块", () => {
    // 旧实现会把选区拼成 `# userselect:` 尾块，与结构化 metadata 形成双路径；
    // 现在参数类型里没有该字段，正文只保留用户自己写的内容。
    const promptText = serializeComposerPromptContexts("解释这段", {
      codeComments: [],
      pluginUiContexts: [],
      pptxElements: [],
      webElements: [],
    });
    expect(promptText).toBe("解释这段");
    expect(promptText).not.toContain("# userselect:");
  });

  it("userInput 行显示 metadata 引用；旧转录的尾块解析结果仍然并列显示", () => {
    const metadataQuotes = [{ comment: "为什么 await 两次？", text: "await load()" }];
    const legacyParsed = [{ text: "old block quote" }];
    expect(mergeRowConversationSelections(metadataQuotes, legacyParsed)).toEqual([
      ...metadataQuotes,
      ...legacyParsed,
    ]);
    expect(mergeRowConversationSelections(undefined, legacyParsed)).toEqual(legacyParsed);
  });
});

describe("投影代际（logEpoch）与批注准入", () => {
  it("引用捕获时的代际与当前投影不同：拒绝而不是复用一个可能指向别处的 rowId", () => {
    const result = admitConversationSelectionQuotes({
      liveLogEpoch: "epoch-2",
      liveRowIds: new Set([7]),
      references: [messageReference({ sourceLogEpoch: "epoch-1" })],
      targetSessionId: "session-a",
    });
    expect(result).toEqual({ ok: false, reason: "staleGeneration" });
  });

  it("代际相同或双方都没有代际时按原 rowId 规则放行", () => {
    expect(
      admitConversationSelectionQuotes({
        liveLogEpoch: "epoch-1",
        liveRowIds: new Set([7]),
        references: [messageReference({ sourceLogEpoch: "epoch-1" })],
        targetSessionId: "session-a",
      }),
    ).toEqual({
      ok: true,
      quotes: [{ text: "await load(); await load();" }],
    });
    expect(
      admitConversationSelectionQuotes({
        liveLogEpoch: "epoch-2",
        liveRowIds: new Set([7]),
        references: [messageReference()],
        targetSessionId: "session-a",
      }),
    ).toEqual({
      ok: true,
      quotes: [{ text: "await load(); await load();" }],
    });
  });
});

describe("旧转录尾块解析接受批注字段", () => {
  it("解析出的引用保留 comment/agent，不整条丢弃", () => {
    const text = [
      "解释这段",
      "",
      "# userselect:",
      "```userselect",
      JSON.stringify([{ text: "quoted", comment: "为什么？", agent: "explore" }]),
      "```",
    ].join("\n");
    const parsed = parsePromptConversationSelections(text);
    expect(parsed.visibleContent).toBe("解释这段");
    expect(parsed.references).toEqual([{ text: "quoted", comment: "为什么？", agent: "explore" }]);
  });
});

describe("批注输入框只经确认进入同一个草稿 owner", () => {
  const scope = { sessionId: "session-a", workspaceKey: "workspace-a" };

  it("确认：comment 写入草稿引用，发送时成为严格契约里的 comment", () => {
    setConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey, []);
    const annotated = buildAnnotatedConversationSelection(
      messageReference() as ConversationSelectionReference,
      "  为什么 await 两次？ ",
    );
    expect(annotated.ok).toBe(true);
    if (!annotated.ok) return;
    // 与 `dispatchConversationSelectionAdd` 相同的草稿 owner 写入；事件派发在
    // conversationSelectionAnnotation.chromium.test.ts 里用真实浏览器覆盖。
    setConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey, [
      annotated.reference,
    ]);
    const admitted = admitConversationSelectionQuotes({
      liveRowIds: new Set([7]),
      references: getConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey),
      targetSessionId: scope.sessionId,
    });
    expect(admitted).toEqual({
      ok: true,
      quotes: [{ comment: "为什么 await 两次？", text: "await load(); await load();" }],
    });
    // 清空 scope，避免模块级草稿表影响其它用例。
    clearConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey);
  });

  it("取消/空批注：不产生引用，草稿 owner 保持原样", () => {
    setConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey, []);
    // 取消 = 根本不调用 dispatch；这里断言判定本身不通过，因此没有任何写入。
    expect(
      buildAnnotatedConversationSelection(
        messageReference() as ConversationSelectionReference,
        "   ",
      ),
    ).toEqual({ ok: false, reason: "empty" });
    expect(getConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey)).toEqual([]);
    clearConversationSelectionReferenceScope(scope.sessionId, scope.workspaceKey);
  });

  it("超过单条批注上限：拒绝，不写进会被线格式砍掉的引用", () => {
    expect(
      buildAnnotatedConversationSelection(
        messageReference() as ConversationSelectionReference,
        "x".repeat(CONVERSATION_SELECTION_MAX_COMMENT_LENGTH + 1),
      ),
    ).toEqual({ ok: false, reason: "tooLong" });
  });
});
