import type { IProjectService } from "./contract.js";

export async function readProjectTree(service: IProjectService) {
  return service.readTree();
}
