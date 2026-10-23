import { CoreErrorType, createCoreError } from "../deps.js";

export function stableForkError(message: string, context: Record<string, unknown> = {}): Error {
  return createCoreError(CoreErrorType.InvalidStateTransition, message, {
    context,
    recoverable: true,
  });
}
