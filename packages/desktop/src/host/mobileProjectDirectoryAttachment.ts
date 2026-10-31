import { type IZCodeAgentService, type IZCodeTaskService } from "@zcode/services";

/** RPC caller cannot omit the admission or supply an in-process admission object. */
export function guardReplayableTaskCreation(port: {
  tasks: IZCodeTaskService;
  agent: IZCodeAgentService;
  assertTarget(params: Parameters<IZCodeTaskService["createTask"]>[0]): void;
  supported: boolean;
  localAdmission?: boolean;
  /**
   * 仅当 tasks 与调用方同进程（本地 Host 服务）时才允许把 in-process assertTarget 作为
   * createTaskExistingRuntime 第三个参数传入。远端 scoped service 经真实 RPC，函数不可序列化；
   * 对端 Host 会在自己的转发边界注入 socket lease 回调，本端只做发送前/结果后的资格复检。
   */
  inProcess?: boolean;
}): IZCodeTaskService {
  return new Proxy(port.tasks, {
    get(target, property, receiver) {
      if (property === "createTask" || property === "createTaskExistingRuntime") {
        return async (
          params: Parameters<IZCodeTaskService["createTask"]>[0],
          expected?: Parameters<IZCodeTaskService["createTaskExistingRuntime"]>[1],
        ) => {
          port.assertTarget(params);
          if (!port.supported) throw new Error("project.existing-runtime-unavailable");
          const runtime = expected ?? (await port.agent.getWorkspaceRuntimeIdentity(params));
          port.assertTarget(params);
          // 只走服务提供的 typed existing-only 入口，不允许普通 create fallback。
          const admission = port.localAdmission
            ? await port.agent.acquireExistingRuntime(params, () => port.assertTarget(params))
            : undefined;
          if (
            admission &&
            (admission.runtimeIdentity.identity !== runtime.identity ||
              admission.runtimeIdentity.generation !== runtime.generation ||
              admission.runtimeIdentity.workspaceKey !== runtime.workspaceKey)
          )
            throw new Error("project.stale-runtime");
          let result;
          if (admission) result = await target.createTask(params, admission);
          else if (port.inProcess) {
            result = await target.createTaskExistingRuntime(params, runtime, () =>
              port.assertTarget(params),
            );
          } else result = await target.createTaskExistingRuntime(params, runtime);
          port.assertTarget(params);
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
