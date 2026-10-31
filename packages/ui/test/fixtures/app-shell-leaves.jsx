// 结构集成夹具只替换重型展示叶子；App、WorkspaceShellLayout、完整视图宿主与状态 owner 均为生产实现。
import { useV4SplitPaneEntry } from "../../src/v4/splitPaneEntryContext.js";
export function DiffsWorkerPoolProvider({ children }) {
  return children;
}
export function SettingsPage() {
  return <section aria-label="Settings ready">Settings</section>;
}
export function OccupationOnboarding({ children }) {
  return children;
}
export function OnboardingDialog() {
  return null;
}
export function SSHDialog() {
  return null;
}
export function DirectoryBrowser() {
  return null;
}
export function CuaPermissionObservationAttachment() {
  return null;
}
export function AnimatedTerminalPanel() {
  return null;
}
export function WorkspaceHeader() {
  return (
    <header data-testid="workspace-header" className="h-12 shrink-0 border-b">
      Header
    </header>
  );
}
export function WorkspaceSidebar() {
  // 只读消费 shell 下发的同一个 split entry context，暴露派生结果给 E2E；
  // 菜单/拖拽索引本身仍由真实 TaskListItem 在生产 shell 中消费。
  const splitEntry = useV4SplitPaneEntry();
  return (
    <aside data-testid="workspace-sidebar" className="w-60 shrink-0 border-r">
      Sidebar
      <span data-testid="app-shell-split-entry-enabled">
        {splitEntry.enabled ? "true" : "false"}
      </span>
    </aside>
  );
}
export function V4WorkspaceChatArea({ sessionId }) {
  // 对话内容不是本守卫的断言对象；保留同一挂载点与宿主输入区 DOM 契约。
  return (
    <div data-testid="app-shell-chat-area" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1" />
      <div data-v4-composer-dock="true" className="shrink-0 p-2">
        <input data-testid="v4-composer-input" placeholder="app shell fixture composer" />
      </div>
      <span data-testid="app-shell-chat-session">{sessionId ?? "draft"}</span>
    </div>
  );
}
export function PreviewPane() {
  return null;
}
export function SidePaneTerminalPane() {
  return null;
}
export function BrowserUseSidePaneContent() {
  return null;
}
export function HumanBrowserView() {
  return null;
}
export function GitPane() {
  return null;
}
export function TreemappingPane() {
  return null;
}
export function WhiteboardPane() {
  return null;
}
export function ModelTrajectoryPane() {
  return null;
}
export function DeveloperToolsPane() {
  return null;
}
export function SidePaneTabOverview() {
  return <div data-testid="side-pane-overview" />;
}
export function SubagentSessionSidePane() {
  return null;
}
export function SubagentDirectorySidePane() {
  return null;
}
export function SelectionSideChatPane() {
  return null;
}
export function BackgroundBashOutputSidePane() {
  return null;
}
export function PlanDetailSidePane() {
  return null;
}
export function WorkflowRunSidePane() {
  return null;
}
export function WorkflowRunDirectorySidePane() {
  return null;
}
export function WorkflowActorSessionSidePane() {
  return null;
}
export function WorkflowWorkspaceSidePane() {
  return null;
}
export function WorkflowArtifactSidePane() {
  return null;
}
