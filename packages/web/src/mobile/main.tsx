import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp.js";
import "@zcode/ui/styles.css";

const container = document.getElementById("mobile-root");
if (!container) {
  throw new Error("mobile-root container is missing");
}

createRoot(container).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
