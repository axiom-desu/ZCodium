import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import {
  GEN_UI_GLOBALS_EVENT,
  GEN_UI_STATE_CONTEXT_KEY,
  GEN_UI_TWEAK_CONTEXT_KEY,
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  type GenUiWidgetState,
  genUiTweakMessageSchema,
  genUiTweakResultSchema,
  genUiTweakAnnotationSchema,
} from "@zcode/shared/gen-ui";
import { installGenUiTweakRuntime } from "./genUiTweakRuntime.js";

const initial = JSON.parse(
  document.getElementById("zcode-gen-ui-initial-state")?.textContent ?? "null",
) as unknown;
let state: GenUiWidgetState | null =
  initial === null ? null : genUiWidgetStateSchema.parse(initial);
const app = new App({ name: "zcode-gen-ui", version: "1" }, {}, { autoResize: true });
installGenUiTweakRuntime(async (_name, message) => {
  await ready;
  return app.request(
    { method: GEN_UI_TWEAK_METHOD, params: genUiTweakMessageSchema.parse(message) },
    genUiTweakResultSchema,
  );
});
const update = (context: Record<string, unknown>) => {
  if (Object.hasOwn(context, GEN_UI_STATE_CONTEXT_KEY)) {
    const next = context[GEN_UI_STATE_CONTEXT_KEY];
    state = next === null ? null : genUiWidgetStateSchema.parse(next);
  }
  if (context.theme === "dark" || context.theme === "light") {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.style.colorScheme = context.theme;
  }
  const variables = (context.styles as { variables?: Record<string, string> } | undefined)
    ?.variables;
  for (const [name, value] of Object.entries(variables ?? {}))
    if (name.startsWith("--")) document.documentElement.style.setProperty(name, value);
  window.dispatchEvent(
    new CustomEvent(GEN_UI_GLOBALS_EVENT, {
      detail: {
        globals: {
          widgetState: structuredClone(state),
          theme: document.documentElement.dataset.theme,
          visualizationAnnotation:
            context[GEN_UI_TWEAK_CONTEXT_KEY] === undefined
              ? null
              : genUiTweakAnnotationSchema.parse(context[GEN_UI_TWEAK_CONTEXT_KEY]),
        },
      },
    }),
  );
};
app.onhostcontextchanged = update;
const ready = app
  .connect(new PostMessageTransport(window.parent, window.parent))
  .then(() => update(app.getHostContext() ?? {}));
void ready.catch((error) =>
  window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
);
let saves = Promise.resolve();
const api = Object.freeze({
  get widgetState() {
    return structuredClone(state);
  },
  setWidgetState(value: unknown) {
    const next = genUiWidgetStateSchema.parse(value);
    const pending = saves
      .catch(() => undefined)
      .then(async () => {
        await ready;
        await app.request({ method: GEN_UI_STATE_METHOD, params: { state: next } }, z.object({}));
        // Service 通知是唯一状态投影；迟到的保存 ACK 不能覆盖另一窗口更新的快照。
      });
    saves = pending;
    return pending;
  },
  async sendFollowUpMessage(value: unknown) {
    const params = genUiFollowUpSchema.parse(value);
    await saves;
    await ready;
    await app.request({ method: GEN_UI_FOLLOW_UP_METHOD, params }, z.object({}));
  },
});
Object.defineProperty(window, "zcode", { value: api, writable: false, configurable: false });
// guest 的 hover/键盘事件不会冒泡到宿主 DOM；只传展示事件，不增加 Agent 能力。
const presentation = (params: { hovered?: boolean; escape?: true }) => {
  void ready
    .then(() => app.request({ method: GEN_UI_PRESENTATION_METHOD, params }, z.object({})))
    .catch(() => {});
};
document.documentElement.addEventListener("pointerenter", () => presentation({ hovered: true }));
document.documentElement.addEventListener("pointerleave", () => presentation({ hovered: false }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) presentation({ escape: true });
});
