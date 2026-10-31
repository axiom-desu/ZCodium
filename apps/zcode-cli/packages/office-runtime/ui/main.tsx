import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getHost } from "#ui/host.ts";
import { PanelView } from "#ui/shell/PanelView.tsx";
import { usePanelController } from "#ui/shell/usePanelController.ts";

const host = getHost();

function Shell() {
  return <PanelView panel={usePanelController()} />;
}

const root = document.getElementById("root")!;
root.textContent = "";
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
void host.ready();
