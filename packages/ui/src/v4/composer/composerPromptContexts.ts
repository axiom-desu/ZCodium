import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import { stripGenUiModelContext } from "@zcode/shared/gen-ui";
import {
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import {
  buildPromptWithPluginUiContexts,
  parsePromptPluginUiContexts,
  type PluginUiModelContext,
} from "@/plugin-ui/index.js";

interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
  /** 插件 UI 经 ui/update-model-context 附加；缺省视为空。 */
  pluginUiContexts?: readonly PluginUiModelContext[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
  pluginUiContexts?: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length +
    (contexts.pluginUiContexts?.length ?? 0)
  );
}

/**
 * 四类 context parser 只识别 prompt 尾块，因此序列化顺序和解析顺序必须严格相反。
 * 插件上下文最后序列化（最外层），解析时最先剥离。
 *
 * 会话选区不在其中：它是 turn metadata（`conversationQuotes`），正文只保留用户自己写的内容。
 * 序列化器不再接受选区参数，历史解析仍识别旧 `# userselect:` 尾块（只读，用于旧转录）。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: Omit<ComposerPromptContexts, "conversationSelections">,
): string {
  const withCodeComments = buildPromptWithCodeComments(text, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  const withPptx = buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
  return buildPromptWithPluginUiContexts(withPptx, contexts.pluginUiContexts ?? []);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
  pluginUiContexts: PluginUiModelContext[];
} {
  const plugin = parsePromptPluginUiContexts(stripGenUiModelContext(content));
  const pptx = parsePromptPptxElementReferences(plugin.visibleContent);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
    pluginUiContexts: plugin.pluginUiContexts,
  };
}
