import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeTaskCreateResult } from "@zcode/shared";
import type { ZCodeAgentWorkspaceRuntimeIdentity } from "../zcode-agent/zcodeAgent.js";

export interface MobileProjectRootIdentity {
  hostId: string;
  projectId: string;
  rootPath: string;
}
export interface MobileProjectRoot {
  rootIdentity: MobileProjectRootIdentity;
  projectName: string;
  enabled: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachmentGeneration?: number;
  runtimeIdentity?: ZCodeAgentWorkspaceRuntimeIdentity;
}
/** Optional only on guarded replayable Host attachments. No directory mutation surface. */
export interface IMobileProjectDirectoryService {
  readProjects(): Promise<MobileProjectRoot[]>;
  createTask(root: MobileProjectRoot): Promise<ZCodeTaskCreateResult>;
}
export const IMobileProjectDirectoryService =
  createServiceDescriptor<IMobileProjectDirectoryService>("mobile-project-directory");
