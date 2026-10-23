import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 只负责旧个人配置的一次性导入。 */
  readonly standalone?: {
    readonly legacyCliUserConfigFilePath?: string;
    readonly onConfigCheckError?: (error: unknown) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    onConfigCheckError: options.standalone?.onConfigCheckError,
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig(
              options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {},
            ),
        }
      : {}),
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        dispose() {
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
