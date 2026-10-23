import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type {
  RespondWorkspaceHookReviewInput,
  RevokeWorkspaceHookTrustInput,
  ToggleWorkspaceHookReviewItemInput,
} from "./types.js";

export interface ZCodeAppWorkspaceHookSurface {
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * Trust store 落盘后本 session 的 coordinator
   * 内存镜像不会自动更新（per-session，仅创建时 load 一次）。Settings 无 task 的
   * pretrust 授权成功后，server 会按 workspace 逐个调用本方法，把文件重载进
   * coordinator 并重发 admission 状态，否则已信任 Hook 继续被拒、banner 不刷新。
   */
  reloadWorkspaceHookTrust(): Promise<void>;
}
