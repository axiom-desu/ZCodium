// 结构集成夹具只替换重型展示叶子；App、WorkspaceShellLayout、完整视图宿主与状态 owner 均为生产实现。
import { useRef, useState } from "react";
import { LexicalChatInput } from "../../src/LexicalChatInput.js";
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
export function WorkspaceSidebar({ workspacePath, onSelectTask, onCreateTask, onOpenCodeViewer }) {
  // 只读消费 shell 下发的同一个 split entry context，暴露派生结果给 E2E；
  // 菜单/拖拽索引本身仍由真实 TaskListItem 在生产 shell 中消费。
  // 手机 Web 用例需要验证「选择任务/新建/打开预览后抽屉收起」，这里只转调 shell
  // 下发的真实回调，并记录调用，不复制任何导航或面板状态。
  const fixture = window.appShellFixture;
  const splitEntry = useV4SplitPaneEntry();
  return (
    <aside data-testid="workspace-sidebar" className="w-60 shrink-0 border-r">
      Sidebar
      <span data-testid="app-shell-split-entry-enabled">
        {splitEntry.enabled ? "true" : "false"}
      </span>
      <button
        type="button"
        data-testid="fixture-select-task"
        onClick={() => {
          fixture.selectedTaskId = "fixture-task";
          // 结构夹具没有真实 task/session 投影；带一个不存在的 remote identity 让
          // shell 的导航目标校验 fail-closed，只验证「选择命令先收起抽屉」这条开合路径。
          onSelectTask(workspacePath, "fixture-task", "fixture-missing-remote-identity");
        }}
      >
        select fixture task
      </button>
      <button
        type="button"
        data-testid="fixture-create-task"
        onClick={() => {
          fixture.newTaskCount += 1;
          onCreateTask();
        }}
      >
        create fixture task
      </button>
      <button
        type="button"
        data-testid="fixture-open-preview"
        onClick={() => {
          fixture.previewOpened = true;
          onOpenCodeViewer?.({
            type: "file",
            title: "fixture.ts",
            path: `${workspacePath}/fixture.ts`,
            workspacePath,
          });
        }}
      >
        open fixture preview
      </button>
    </aside>
  );
}
// 手机 E2E 需要验证真实 Lexical 编辑器的 16px token 与「resize 不丢草稿」；
// 不能用自造的 <input class="text-mobile-input-safe"> 自证——那样断言只复述夹具的类名。
// 仅在 Web surface（手机用例）挂生产 LexicalChatInput：mention 面板关闭，catalog RPC 用
// 空 workspacePath 关闭（不模拟目录数据、不发真实请求）；16px 字体与草稿由生产实现决定。
// ConversationComposer 的自动聚焦接线不在夹具内复制（纯函数探针无法证明 wiring），
// 由主线补充真实 Composer 的定向源码 + 决策测试。
// 结构与分屏守卫（无 surface=web）保留极简占位，不重引入会自证的伪输入。
const WEB_SURFACE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("surface") === "web";

export function V4WorkspaceChatArea({ workspaceIdentity, sessionId }) {
  // 对话内容不是本守卫的断言对象；保留同一挂载点与宿主输入区 DOM 契约。
  const inputApiRef = useRef(null);
  const [draft, setDraft] = useState("");
  const editor = WEB_SURFACE ? (
    <LexicalChatInput
      inputTestId="v4-composer-input"
      placeholder="app shell fixture composer"
      // 空 workspacePath 关闭 @/#/子智能体 catalog RPC：本用例不断言目录内容。
      workspacePath=""
      workspaceIdentity={workspaceIdentity}
      taskId={null}
      editorApiRef={inputApiRef}
      onChange={setDraft}
      onSubmit={() => true}
      enableMentionPanel={false}
    />
  ) : (
    <div data-testid="app-shell-composer-placeholder" className="p-2 text-ui-base">
      composer
    </div>
  );
  return (
    <div data-testid="app-shell-chat-area" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1" />
      <div
        data-v4-composer-dock="true"
        data-composer-draft-length={draft.length}
        className="shrink-0 p-2"
      >
        {editor}
      </div>
      <span data-testid="app-shell-chat-session">{sessionId ?? "draft"}</span>
    </div>
  );
}
// 面板真实挂载后会自动渲染 code-viewer 的重型文件管理器；这里只保留宿主可见的占位，
// 让手机断言观察面板/frame 几何而不是预览业务内容。
export function FileManagerPane() {
  return <div data-testid="fixture-file-manager-pane" />;
}
export function WorkspaceFileTree() {
  return null;
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
