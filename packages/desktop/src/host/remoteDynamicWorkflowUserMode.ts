import type { DynamicWorkflowMode } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";

/** 需要同步 DWF 用户选择的远端 Host；桌面本地 Host 自己读设置，不在列表里。 */
interface DynamicWorkflowUserModePushTarget {
  /** Source 身份仅用于日志/去重；不用它判断是否要推。 */
  sourceServerId?: string;
  zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
}

/**
 * 把动态工作流的用户选择推给远端 Host（docs/dynamic-workflow/launch.md「The user's choice」）。
 *
 * desktop-attached remote Host 读不到桌面设置，选择只能由 desktop 推送：建立远程 workspace services
 * 时推一次，本机 Host 收到选择变化信号后再推给本窗口所有在线连接。
 * 单个连接失败（旧版本不认识该方法、连接已断）只上报，不影响其它连接，也不阻断远程连接建立。
 */
export async function pushDynamicWorkflowUserModeToRemoteHosts(
  targets: ReadonlyArray<DynamicWorkflowUserModePushTarget>,
  mode: DynamicWorkflowMode | undefined,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      try {
        await target.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
      } catch (error) {
        onError(error);
      }
    }),
  );
}
