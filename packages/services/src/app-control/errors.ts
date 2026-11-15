import { SessionControlError } from "@zcode/session-control/contracts";

/**
 * App control 的可预期失败必须映射成稳定错误码：响应会进模型上下文，
 * 底层异常文本可能带路径或远端地址，所以这里只暴露明确原因。
 */
export function forbidden(message: string): SessionControlError {
  return new SessionControlError("forbidden", message);
}
export function unavailable(message: string): SessionControlError {
  return new SessionControlError("unavailable", message);
}
export function invalidInput(message: string): SessionControlError {
  return new SessionControlError("invalid_input", message);
}
