/**
 * 能力后端分派：只调用 Host 现有服务的只读投影，不新增业务 owner。
 * 表里没有的能力在前面已被网关拒绝；这里的 default 只是防御，不静默降级。
 */
interface CapabilityDispatchOptions {
  readSettings(): Promise<{ locale: string }>;
  readProjects?(): Promise<Array<{ id: string; name: string }>>;
  workspaceIdentity(): string | null;
  currentRevision(): number;
}

export function createCapabilityDispatcher(
  options: CapabilityDispatchOptions,
): (capabilityId: string, input: unknown, signal: AbortSignal) => Promise<unknown> {
  return async (capabilityId, _input, signal) => {
    if (signal.aborted) throw new Error("canceled");
    switch (capabilityId) {
      case "settings.get": {
        const settings = await options.readSettings();
        return { locale: settings.locale };
      }
      case "projects.list": {
        if (!options.readProjects) return [];
        const projects = await options.readProjects();
        return projects.map((project) => ({ id: project.id, name: project.name }));
      }
      case "context.get":
        return {
          workspaceIdentity: options.workspaceIdentity() ?? "",
          revision: options.currentRevision(),
        };
      default:
        throw new Error(`unsupported-capability:${capabilityId}`);
    }
  };
}
