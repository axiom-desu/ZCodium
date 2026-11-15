import {
  expandCustomCommandPrompt,
  type ExecutionPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { loadZCodeCustomCommand, type ListZCodeCustomCommandsOptions } from "./custom-commands.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveZCodeCustomCommandPromptOptions extends ListZCodeCustomCommandsOptions {
  /**
   * @deprecated 自定义命令的 `!` 块不再由 CLI 执行，改写成交给模型 Bash 工具的说明
   * （contracts 的 handOffCustomCommandShellBlocks）。字段保留只为兼容 create-app-runtime 的
   * 现有传参；该调用点属 C4 写域，删除传参随集成清单进行。读取它是错的。
   */
  executionPort?: ExecutionPort;
  /** @deprecated 同上：shell 展开取消后不再需要会话身份。 */
  sessionId?: SessionId;
  /** @deprecated 同上：解析阶段不再执行任何子进程，因此没有可取消的执行。 */
  signal?: AbortSignal;
  /** @deprecated 同上：解析阶段不再产生执行 trace。 */
  traceContext?: TraceContext;
}

export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ResolveZCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // 保留名（含内置 `workflow`）在这里直接返回 undefined，与「命令不存在」同形：内置命令由
  // builtin-prompt-command.ts 先行展开，这里拒绝的是借同名自定义命令绕过内置语义（或功能开关）的路径。
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    // 解析只改写文本：`!` 块交给模型经 Bash 工具执行，见 contracts 的 handOffCustomCommandShellBlocks。
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
