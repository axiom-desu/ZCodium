export { createProjectService, bindRemoteProjectIdentities } from "#src/project/app/index.js";
export { createProjectSessionCreationPort } from "#src/project/app/sessionCreation.js";
export type { ProjectSessionCreationPort } from "#src/project/app/sessionCreation.js";
export {
  createTaskAutoArchiveScheduler,
  shouldRescanTaskAutoArchive,
} from "#src/project/app/autoArchiveScheduler.js";
export { createLegacySingleRootProjectService } from "#src/project/adapters/legacy-single-root.js";
export { IProjectService } from "#src/project/domain/contract.js";
export { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project-storage/contract.js";
export type {
  ProjectDirectories,
  ProjectRoot,
  ProjectTask,
  ProjectTaskGroup,
  ProjectTaskGroupColor,
  ProjectTaskGroupMember,
  ProjectTaskGroupStructure,
  ProjectTaskGroupTopOrder,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project/domain/contract.js";
