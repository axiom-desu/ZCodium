import type { AppControlNavigationWindow } from "./contract.js";

export function registerNavigationSurface(surface: AppControlNavigationWindow) {
  surface.register("renderer-generation");
  return () => surface.unregister("renderer-generation");
}
