import { resolveLocale } from "@zcode/i18n";
import { resolveRegistryModelSelection } from "./provider-registry-selection.js";
import type {
  CreateSessionFacadeDeps,
  RegistrySelectionState,
  SessionFacadeContext,
} from "./session-facade-types.js";

export function createSessionFacadeContext(deps: CreateSessionFacadeDeps): SessionFacadeContext {
  const state = {
    appProvidedToolNames: [] as string[],
    currentLocale: resolveLocale(deps.configResult.config.ui.locale),
  };

  const currentRegistrySelection = (): RegistrySelectionState => {
    const registry = deps.providerRegistry;
    const selection = deps.runtime.getSessionModelSelection();
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  return {
    deps,
    state,
    currentRegistrySelection,
    setCurrentLocale: (locale) => {
      state.currentLocale = locale;
    },
  };
}
