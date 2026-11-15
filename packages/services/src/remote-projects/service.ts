import type { VirtualProject } from "#src/project/contract.js";
import type {
  RemoteProjectEntryInput,
  RemoteProjectRefreshEntry,
  RemoteProjectRepositoryContract,
} from "#src/project-storage/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
import { composeProjectCatalog } from "#src/remote-projects/catalog.js";

export function createRemoteProjectService(options: {
  repository(): Promise<RemoteProjectRepositoryContract>;
  readLocalProjects(hostId?: string): Promise<VirtualProject[]>;
}): IRemoteProjectService {
  return {
    async listEntries(params) {
      return (await options.repository()).list(params?.hostId);
    },
    async addEntry(input: RemoteProjectEntryInput) {
      return (await options.repository()).add(input);
    },
    async refreshDirectory(input: {
      hostId: string;
      membershipId: string;
      entries: readonly RemoteProjectRefreshEntry[];
    }) {
      return (await options.repository()).refresh(input);
    },
    async removeEntry(params) {
      (await options.repository()).remove(params.entryId, params.hostId);
    },
    async restoreEntry(params) {
      return (await options.repository()).restore(params.entryId, params.hostId);
    },
    async readCatalog(params) {
      const [localProjects, remoteEntries] = await Promise.all([
        options.readLocalProjects(params?.hostId),
        (await options.repository()).list(params?.hostId),
      ]);
      return composeProjectCatalog({ localProjects, remoteEntries });
    },
  };
}
