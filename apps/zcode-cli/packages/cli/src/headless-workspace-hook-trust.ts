import type { RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";

const HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS = [
  "workspace_hooks_pending_trust",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_feature_disabled",
] as const;
type HeadlessWorkspaceHookBlockReason = (typeof HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS)[number];

export async function resolveHeadlessWorkspaceHookTrustDiagnostic(input: {
  bootstrapModule: Awaited<ReturnType<typeof loadBootstrapModule>> | undefined;
  deps: RunDependencies;
  events: readonly unknown[];
  workingDirectory: string;
}) {
  let reasonCode: HeadlessWorkspaceHookBlockReason | undefined;
  for (const event of input.events) {
    if (!event || typeof event !== "object") continue;
    const value = event as {
      type?: string;
      payload?: { errorCode?: string; descriptor?: { sourceKind?: string } };
    };
    if (value.type !== "hook_run_blocked" || value.payload?.descriptor?.sourceKind !== "project") {
      continue;
    }
    const errorCode = value.payload.errorCode;
    if (isHeadlessWorkspaceHookBlockReason(errorCode)) {
      reasonCode = errorCode;
      break;
    }
  }
  if (!reasonCode) return undefined;
  const inspect =
    input.deps.inspectWorkspaceHookTrust ?? input.bootstrapModule?.inspectWorkspaceHookTrust;
  if (!inspect) return undefined;
  const status = await inspect({
    workspacePath: input.workingDirectory,
    ...(input.deps.userConfigPath ? { userConfigPath: input.deps.userConfigPath } : {}),
  });
  return { ...status, reasonCode };
}

function isHeadlessWorkspaceHookBlockReason(
  value: string | undefined,
): value is HeadlessWorkspaceHookBlockReason {
  return HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS.some((candidate) => candidate === value);
}

type HeadlessWorkspaceHookTrustStatus = Awaited<
  ReturnType<NonNullable<RunDependencies["inspectWorkspaceHookTrust"]>>
>;

/** --json 摘要里的工作区 hook 信任投影；仅在真正被拦截时出现，字段顺序与旧内联展开一致。 */
export function formatHeadlessWorkspaceHookTrustSummary(
  status: HeadlessWorkspaceHookTrustStatus | undefined,
): Record<string, unknown> {
  if (!status) return {};
  return {
    workspaceHookTrust: {
      workspacePath: status.workspacePath,
      workspaceIdentity: status.workspaceIdentity,
      bundleDigest: status.bundleDigest,
      reasonCode: status.reasonCode,
      items: status.items.map((item) => ({
        reviewItemId: item.reviewItemId,
        event: item.event,
        matcher: item.matcher,
        displayCommand: item.displayCommand,
        sourcePath: item.sourcePath,
        configuredEnabled: item.configuredEnabled,
        hookDeclarationDigest: item.hookDeclarationDigest,
        trustState: item.trustState,
      })),
    },
  };
}

export function writeHeadlessWorkspaceHookTrustDiagnostic(
  ctx: RunContext,
  status: HeadlessWorkspaceHookTrustStatus,
): void {
  ctx.stderr.write(
    [`Workspace Hooks skipped: ${status.reasonCode}`, "Review with: zcode hooks trust review"].join(
      "\n",
    ) + "\n",
  );
}
