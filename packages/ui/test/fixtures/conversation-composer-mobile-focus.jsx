import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ConversationComposer } from "../../src/v4/ConversationComposer.js";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";

// 定向浏览器夹具：只挂真实 ConversationComposer（snapshot=null + draftMode），
// 用来观察「草稿恢复是否抢焦点」。这里不复制任何焦点决策：
// autoFocusEnabled / viewport / disabled 全部走生产组件，夹具只提供草稿与重挂载入口。
// 服务与平台都是纯内存 fake：不读真实配置、不发起网络请求。
const workspacePath = "/fixture/composer-focus";

const noop = () => {};
const noopSub = Object.assign(() => noopSub, { dispose() {} });

// 未知服务统一返回内存 fake：读属性得到子 fake，调用只 resolve(undefined)，不触碰真实 IO。
function makeService(name) {
  return new Proxy(function () {}, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      if (key === "then") return undefined;
      if (String(key).startsWith("on") || key === "subscribe" || key === "onMessage") {
        return noopSub;
      }
      const child = makeService(`${name}.${String(key)}`);
      Reflect.set(target, key, child);
      return child;
    },
    apply() {
      return Promise.resolve(undefined);
    },
  });
}

const services = new Proxy(
  {
    broadcastService: { onMessage: noopSub, async send() {} },
    // 目录只读 fake：返回空列表，避免把「读不到 subagents」当成用例失败噪声。
    subagentsService: {
      async list() {
        return { agents: [], capability: null };
      },
    },
  },
  { get: (target, key) => (key in target ? target[key] : makeService(String(key))) },
);

// 平台 stub 必须缓存返回的函数：每次访问都新建闭包会让消费方 effect 依赖每渲染都变，
// 在视口切换时空转成无限重渲染（曾把 renderer 直接卡死）。
const platformValues = {
  getDesktopZoomLevel: async () => ({ zoomLevel: 0 }),
  getUpdateState: async () => ({ kind: "idle" }),
};
const platform = new Proxy(platformValues, {
  get(target, key) {
    if (key in target) return target[key];
    if (String(key).startsWith("on")) {
      const subscribe = () => noop;
      Reflect.set(target, key, subscribe);
      return subscribe;
    }
    const handler = async () => undefined;
    Reflect.set(target, key, handler);
    return handler;
  },
});

// 所有传给真实 composer 的回调必须是模块级稳定引用（内联闭包 + 不稳定草稿对象会
// 让消费方 effect 每渲染重跑，视口切换时直接空转成死循环）。
const handleSendText = async () => "sent";
const handleAttachmentPut = async () => ({ attachmentId: "fixture-attachment" });

function blurActiveElement() {
  const active = document.activeElement;
  if (active && typeof active.blur === "function") active.blur();
}

const fixture = (window.composerMobileFixture = {
  mounts: 0,
  draftUpdates: [],
  replaceDrafts: [],
  state: {
    mountId: 0,
    autoFocusEnabled: true,
    draft: { text: "fixture restored draft" },
  },
  /** 重挂载真实 composer：新 key → 卸载旧编辑器，再走一次挂载期草稿恢复。 */
  remount: () => {},
  blurActiveElement,
});
fixture.state = { ...fixture.state };

function ComposerMount({ state, onDraftChange, onReplaceDraft }) {
  useEffect(() => {
    fixture.mounts += 1;
  }, []);

  // 只在草稿语义字段变化时换引用，等价于宿主侧「同一份草稿事实」。
  const composerDraft = useMemo(() => ({ updatedAt: 1, ...state.draft }), [state.draft]);

  return (
    <ConversationComposer
      snapshot={null}
      sessionId={null}
      draftMode
      composerDraft={composerDraft}
      updateComposerContent={onDraftChange}
      replaceComposerDraft={onReplaceDraft}
      attachmentPut={handleAttachmentPut}
      autoFocusEnabled={state.autoFocusEnabled}
      workspacePath={workspacePath}
      onSendText={handleSendText}
      onStop={noop}
      onSelectModel={noop}
      onSelectThought={noop}
      onSwitchMode={noop}
    />
  );
}

function Harness() {
  const [state, setState] = useState(fixture.state);
  fixture.state = state;
  fixture.remount = (next) =>
    setState((previous) => ({
      ...previous,
      ...next,
      draft: next.draft ?? previous.draft,
      mountId: previous.mountId + 1,
    }));

  const onDraftChange = useCallback((content) => {
    fixture.draftUpdates.push(content);
  }, []);
  const onReplaceDraft = useCallback((next) => {
    fixture.replaceDrafts.push(next);
  }, []);

  return (
    <div
      data-testid="composer-focus-harness"
      className="flex h-full min-h-0 flex-col justify-end p-2"
    >
      <ComposerMount
        key={`composer-mount-${state.mountId}`}
        state={state}
        onDraftChange={onDraftChange}
        onReplaceDraft={onReplaceDraft}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <ServiceProvider services={services}>
        <PlatformProvider platform={platform}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <Harness />
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);

// 断言入口用同一个真实编辑器实例：E2E bridge 已由 LexicalChatInput 挂在输入框上。
window.composerMobileFixture.readEditorText = () => {
  const input = document.querySelector(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
  const bridge = input?.__zcodeLexicalInputE2E;
  return bridge ? bridge.getText() : (input?.textContent ?? null);
};
