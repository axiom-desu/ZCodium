import type { AgentRuntimeInternal } from "../internal.js";
import type { WorkspaceFileRewindPreview } from "../types.js";
import { buildWorkspaceFileRewindPlan, toPreview } from "./file-rewind-plan.js";
import type { WorkspaceFileRewindTargetOptions } from "./file-rewind-plan.js";

export { applyWorkspaceFileRewind } from "./file-rewind-apply.js";

export async function previewWorkspaceFileRewind(
  this: AgentRuntimeInternal,
  options: WorkspaceFileRewindTargetOptions = {},
): Promise<WorkspaceFileRewindPreview> {
  const plan = await buildWorkspaceFileRewindPlan.call(this, options);
  return toPreview(plan);
}
