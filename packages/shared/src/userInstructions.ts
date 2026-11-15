/**
 * 用户自定义指令（设置页「个性化」）的共享常量。
 *
 * 事实源文件由 `getAgentUserInstructionsFilePath()`（`@zcode/services/paths`）解析：
 * 本仓 CLI 从 `{HOME}/.zcodium/AGENTS.md` 读取用户级默认指令
 * （`apps/zcode-cli/packages/adapters/src/context/index.ts` 的 `findDefaultUserInstructionFile`），
 * 设置页必须写同一路径，否则保存后新会话读不到。
 */

/** 用户指令 UTF-8 字节上限；与 CLI 读取截断保持一致（100KB）。 */
export const USER_INSTRUCTIONS_MAX_BYTES = 100 * 1024;

/** `saveUserInstructions` 拒绝超限内容时抛出的错误码。 */
export const USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE = "user_instructions_too_large";
