import React from "react";
import { createRoot } from "react-dom/client";
import enMessages from "../../../packages/ui/src/i18n/locales/en-US.ts";
import zhMessages from "../../../packages/ui/src/i18n/locales/zh-CN.ts";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.tsx";
import { WebRemoteControlDialog } from "../../../packages/ui/src/WebRemoteControlDialog.tsx";
import "../../../packages/ui/src/styles.css";

const DICTIONARIES = { "en-US": enMessages, "zh-CN": zhMessages };

function App() {
  const [open, setOpen] = React.useState(true);
  const [locale, setLocale] = React.useState("en-US");
  React.useEffect(() => {
    window.fixtureEvents = [];
    window.fixtureDictionaries = DICTIONARIES;
    window.setDialogOpen = setOpen;
    // 真实 ZCodeIntlProvider 的 initialLocale 只在挂载时读取；
    // 切换语言时用 key 重新挂载，避免在 fixture 里伪造第二套 intl 状态。
    window.setFixtureLocale = setLocale;
    window.setFixtureBusy = (busy) => {
      window.fixtureBusy = busy;
      window.dispatchEvent(new Event("fixture-state"));
    };
    window.setFixtureState = (state) => {
      window.fixtureRemoteState = state;
      window.dispatchEvent(new Event("fixture-state"));
    };
  }, []);
  return (
    <ZCodeIntlProvider key={locale} initialLocale={locale}>
      <WebRemoteControlDialog
        open={open}
        onOpenChange={(next) => {
          window.fixtureEvents.push(["dialog-open", next]);
          setOpen(next);
        }}
        workspacePath="/fixture/workspace"
        workspaceIdentity="fixture-identity"
        remoteSessionId="fixture-session"
      />
      <output data-testid="fixture-events">{JSON.stringify(window.fixtureEvents)}</output>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
