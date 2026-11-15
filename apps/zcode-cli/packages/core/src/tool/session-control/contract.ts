import type { SessionTaskType } from "@zcode/contracts";
import type {
  AppSessionControl,
  AppSessionTrustedContext,
  CliSessionControl,
  CliTrustedContext,
} from "@zcode/session-control/contracts";

/**
 * 启动装配绑定来源与权限；工具 JSON 不能选择 surface 或重建调用者。
 * 独立 CLI 根拿 `cli` 绑定（本机会话库）；Desktop Host 的会话在 `appControlEnabled`
 * 时拿 `app` 绑定（经既有 CLI↔Host 连接反向调用，不在 CLI 内另建 owner）。
 */
export interface CliSessionControlBinding {
  kind: "cli";
  control: CliSessionControl;
  context(): CliTrustedContext;
}
export interface AppSessionControlBinding {
  kind: "app";
  control: AppSessionControl;
  context(): AppSessionTrustedContext;
}
export type SessionControlBinding = CliSessionControlBinding | AppSessionControlBinding;

/**
 * 同一份绑定既决定注册面也决定执行面，必须用同一个入口推导。
 * taskType 的子会话种类并不都使用 runtimeScope=subagent，所以只认明确的主根类型；
 * 根会话不符也返回 undefined，防止跨会话冒用别的绑定。
 */
export function sessionControlForRuntime(
  binding: SessionControlBinding | undefined,
  taskType: SessionTaskType | undefined,
  sessionId: string,
): SessionControlBinding | undefined {
  // 根因：绑定曾只按 runtimeScope 过滤，导致 fork/selection_side_chat 这类仍带 main scope 的
  // 子会话能创建并控制其他会话。这里按持久 taskType 收口，只有独立主根三种身份保留能力。
  if (
    taskType !== undefined &&
    taskType !== "interactive" &&
    taskType !== "fork" &&
    taskType !== "workflow_parent"
  )
    return undefined;
  if (binding?.context().rootSession.sessionId !== sessionId) return undefined;
  return binding;
}
