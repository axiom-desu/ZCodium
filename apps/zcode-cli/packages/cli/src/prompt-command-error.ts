import { safeDiagnosticFrames, safeLogArgs } from "@zcode/shared";

interface ErrorOutput {
  stderr: { write(chunk: string): unknown };
}

export function writePromptCommandError(
  ctx: ErrorOutput,
  error: unknown,
  verbose: boolean,
): void {
  ctx.stderr.write(`Error: ${JSON.stringify(safeLogArgs([error]))}\n`);
  if (!verbose) return;
  if (error instanceof Error && error.cause) {
    ctx.stderr.write(`Cause: ${JSON.stringify(safeLogArgs([error.cause]))}\n`);
  }
  if (error instanceof Error && error.stack) {
    ctx.stderr.write(`${safeDiagnosticFrames(error.stack).join("\n")}\n`);
  }
}
