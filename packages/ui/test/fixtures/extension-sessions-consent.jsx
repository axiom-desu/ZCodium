import { createRoot } from "react-dom/client";
import { ExtensionStatusSlotView } from "@/extensions/components/ExtensionStatusSlotView.js";
import { selectSlotView } from "@/extensions/domain/slotSelectors.js";
import { consentGrantRequest } from "@/extensions/domain/consent.js";
import { LOCALE_MESSAGES } from "@/i18n/localeMessages.js";

// 真实组件 + 真实英文文案的授权交互夹具：快照 → selectSlotView（生产选择器）→
// ExtensionStatusSlotView（生产展示组件）→ 点击 Enable → consentGrantRequest（生产提交判定）。
// 不复制授权语义，也不 mock 网关：Host 服务端的接受/拒绝由 services 回归覆盖。
const messages = LOCALE_MESSAGES["en-US"];
const labels = {
  label: messages["extensions.status.label"],
  start: messages["extensions.status.start"],
  stop: messages["extensions.status.stop"],
  enable: messages["extensions.status.enable"],
  revoke: messages["extensions.status.revoke"],
  pending: messages["extensions.status.pending"],
  loading: messages["extensions.status.loading"],
  error: messages["extensions.status.error"],
  grants: {
    "projects.read": messages["extensions.status.grant.projects.read"],
    "sessions.read": messages["extensions.status.grant.sessions.read"],
    "sessions.write": messages["extensions.status.grant.sessions.write"],
  },
  notice: messages["extensions.status.notice"],
};

const snapshot = {
  revision: 1,
  generation: 0,
  workspaceIdentity: "local:/tmp/ext-consent",
  phase: "stopped",
  plugins: [
    {
      pluginId: "demo-sessions",
      name: "Demo Sessions",
      version: "1.0.0",
      declared: ["projects.read", "sessions.write"],
      granted: [],
      recorded: [],
      status: "needs-consent",
      capabilities: ["sessions.listSessions", "sessions.renameSession"],
      protocols: { sessions: 1 },
    },
  ],
  slots: [],
};

const view = selectSlotView(snapshot, "status.composer", { available: true, loading: false });
window.consentFixture = { requests: [], view };

createRoot(document.getElementById("root")).render(
  <ExtensionStatusSlotView
    view={view}
    labels={labels}
    actions={{
      start() {},
      stop() {},
      revoke() {},
      grant(pluginId) {
        const plugin = view.pending.find((candidate) => candidate.pluginId === pluginId);
        if (plugin) window.consentFixture.requests.push(consentGrantRequest(plugin));
      },
    }}
  />,
);
