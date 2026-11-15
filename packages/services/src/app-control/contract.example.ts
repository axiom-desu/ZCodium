import { createAppControlService } from "./index.js";

export function createExampleAppControl(deps: Parameters<typeof createAppControlService>[0]) {
  return createAppControlService(deps);
}
