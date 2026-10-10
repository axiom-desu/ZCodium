/** Generated dependencies are confined to the shared MCP host, never a workspace install. */
export const CUA_RUNTIME_MODULES_PATH = "dist/mcp/node_modules";

export function cuaNativePackage(platform: string, arch: string): string {
  if (!["linux", "win32", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported CUA target: ${platform}-${arch}`);
  }
  const suffix = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  return `@trycua/cua-driver-${platform}-${arch}${suffix}`;
}

export function cuaRuntimeRequiredPaths(platform: string, arch: string): string[] {
  const native = cuaNativePackage(platform, arch);
  const library =
    platform === "win32"
      ? "cua_driver_sdk.dll"
      : platform === "darwin"
        ? "libcua_driver_sdk.dylib"
        : "libcua_driver_sdk.so";
  return [
    "dist/mcp/CUA-NOTICES.md",
    ...[
      "@trycua/cua-driver/package.json",
      "@trycua/cua-driver/dist/index.js",
      "@trycua/cua-driver/dist/native/node-runtime.js",
      "@ubjs/core/package.json",
      "@ubjs/core/dist/esm/index.js",
      "@ubjs/node/package.json",
      "@ubjs/node/typescript/dist/resolve-lib.js",
      `${native}/package.json`,
      `${native}/${library}`,
      `${native}/cua_driver_node_runtime.node`,
      `${native}/node-runtime-NOTICE.md`,
    ].map((path) => `${CUA_RUNTIME_MODULES_PATH}/${path}`),
  ];
}

/** Immutable asset contract shared by bootstrap, desktop staging and remote deployment. */
export const BUILTIN_PLUGIN_SEED_PATHS = {
  "browser-use-plugin": [
    "docs/api.json",
    "docs/documents.json",
    "docs/overview.md",
    "docs/recording.md",
    "docs/workflow.md",
    "scripts/browser-client.mjs",
    "skills/control-browser/SKILL.md",
    "skills/web-gui-tester/SKILL.md",
  ],
  "node-repl-host": ["dist/mcp/server.js"],
  "android-emulator-plugin": [
    "dist/mcp/server.js",
    ".mcp.json",
    "commands/android-dev.md",
    "hooks/hooks.json",
    "skills/android-dev/INSTALL_ENVIRONMENT.md",
    "skills/android-dev/SKILL.md",
    "templates/compose-app/README.md",
  ],
  "ios-simulator-plugin": [
    "dist/mcp/server.js",
    ".mcp.json",
    "commands/ios-dev.md",
    "hooks/hooks.json",
    "skills/ios-dev/SKILL.md",
    "templates/swiftui-app/README.md",
  ],
  // Bugfix：上游 662c30bea（UI plugins / Gen UI）把 visualize-plugin 加进了 staged 官方
  // 插件清单，但那次 cherry-pick（6bb868c）只搬了插件源码，没有搬这份注册表——
  // 本仓库的清单是派生自这里的（BUILTIN_PLUGIN_ASSETS 由本表的键生成），上游则是内联
  // 写在 prepare-agent-node-bundle.mjs 里。缺这一条的后果：桌面打包与远端部署都不会
  // stage visualize-plugin，Gen UI 技能在安装包里整体缺失（/visualize 展开时找不到
  // 技能文件），且因为没有 requiredSeedPaths 校验，构建期不会报错。
  // 路径清单照搬上游 prepare-agent-node-bundle.mjs 的 requiredSeedPaths。
  "visualize-plugin": [
    "skills/visualize/SKILL.md",
    "skills/visualize/references/api.md",
    "skills/visualize/references/styles.md",
    "skills/visualize/tweak.md",
    "skills/visualize/LICENSE.md",
    "skills/visualize/scripts/render.py",
    "skills/visualize/assets/visualize.css",
    "skills/visualize/assets/visualize.html",
    "skills/visualize/assets/calendar.js",
    "skills/visualize/assets/runtime-manifest.json",
    "skills/visualize/scripts/vendor.py",
    "skills/visualize/assets/vendor/manifest.json",
    "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
    "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
    "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
    "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
    "skills/visualize/assets/vendor/lucide-1.17.0.js",
    "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
    "skills/visualize/assets/vendor/d3-7.9.0.min.js",
    "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
    "skills/visualize/widgets/calendar.md",
    "skills/visualize/examples/calendar.html",
    "skills/visualize/assets/standalone-host-bridge.js",
    "skills/visualize/assets/standalone-shell.js",
  ],
  "presentations-plugin": [
    "agents/visual-judge.md",
    "skills/pptx/LICENSE.txt",
    "skills/pptx/SKILL.md",
  ],
  "documents-plugin": [
    "agents/visual-judge.md",
    "skills/docx/LICENSE.txt",
    "skills/docx/SKILL.md",
    "skills/docx/env_setup/env_check.sh",
    "skills/docx/env_setup/font_list.txt",
    "skills/docx/env_setup/setup.md",
    "skills/docx/env_setup/setup_mac_linux.sh",
    "skills/docx/env_setup/setup_windows.ps1",
    "skills/docx/references/chart-templates.md",
    "skills/docx/references/common-rules.md",
    "skills/docx/references/decorations.md",
    "skills/docx/references/design-system.md",
    "skills/docx/references/docx-js-advanced.md",
    "skills/docx/references/docx-js-core.md",
    "skills/docx/references/faq.md",
    "skills/docx/references/math-formulas.md",
    "skills/docx/references/ooxml.md",
    "skills/docx/references/toc.md",
    "skills/docx/routes/comment.md",
    "skills/docx/routes/create.md",
    "skills/docx/routes/edit.md",
    "skills/docx/routes/format.md",
    "skills/docx/routes/read.md",
    "skills/docx/scenes/academic.md",
    "skills/docx/scenes/contract.md",
    "skills/docx/scenes/copywriting.md",
    "skills/docx/scenes/exam.md",
    "skills/docx/scenes/official-doc.md",
    "skills/docx/scenes/report.md",
    "skills/docx/scenes/resume.md",
    "skills/docx/scripts/__init__.py",
    "skills/docx/scripts/add_toc_placeholders.py",
    "skills/docx/scripts/document.py",
    "skills/docx/scripts/fix_footer_fields.py",
    "skills/docx/scripts/postcheck.py",
    "skills/docx/scripts/templates/comments.xml",
    "skills/docx/scripts/templates/commentsExtended.xml",
    "skills/docx/scripts/templates/commentsExtensible.xml",
    "skills/docx/scripts/templates/commentsIds.xml",
    "skills/docx/scripts/templates/people.xml",
    "skills/docx/scripts/utilities.py",
    "skills/docx/setup.sh",
  ],
  "pdf-plugin": [
    "agents/visual-judge.md",
    "skills/pdf/LICENSE.txt",
    "skills/pdf/SKILL.md",
    "skills/pdf/briefs/academic.md",
    "skills/pdf/briefs/creative-fixed-canvas.md",
    "skills/pdf/briefs/creative-flow.md",
    "skills/pdf/briefs/creative.md",
    "skills/pdf/briefs/poster.md",
    "skills/pdf/briefs/process-advanced.md",
    "skills/pdf/briefs/process.md",
    "skills/pdf/briefs/report.md",
    "skills/pdf/briefs/resume.md",
    "skills/pdf/configs/components.md",
    "skills/pdf/configs/fonts.md",
    "skills/pdf/configs/visual_framework.md",
    "skills/pdf/env_setup/env_check.sh",
    "skills/pdf/env_setup/font_list.txt",
    "skills/pdf/env_setup/setup.md",
    "skills/pdf/env_setup/setup_mac_linux.sh",
    "skills/pdf/env_setup/setup_windows.ps1",
    "skills/pdf/references/resume-academic.tex",
    "skills/pdf/references/resume-altacv.tex",
    "skills/pdf/scripts/cover_render.py",
    "skills/pdf/scripts/cover_validate.js",
    "skills/pdf/scripts/design_engine.py",
    "skills/pdf/scripts/html2pdf-next.js",
    "skills/pdf/scripts/html2poster.js",
    "skills/pdf/scripts/pdf.py",
    "skills/pdf/scripts/pdf_qa.py",
    "skills/pdf/scripts/poster_validate.py",
    "skills/pdf/scripts/setup.sh",
    "skills/pdf/scripts/toc_validate.py",
    "skills/pdf/typesetting/charts.md",
    "skills/pdf/typesetting/cover-backgrounds.md",
    "skills/pdf/typesetting/cover.md",
    "skills/pdf/typesetting/fill-engine.md",
    "skills/pdf/typesetting/geometry.md",
    "skills/pdf/typesetting/overflow.md",
    "skills/pdf/typesetting/pagination.md",
    "skills/pdf/typesetting/palette.md",
    "skills/pdf/typesetting/typography.md",
  ],
  "spreadsheets-plugin": [
    "agents/visual-judge.md",
    "skills/xlsx/LICENSE.txt",
    "skills/xlsx/SKILL.md",
    "skills/xlsx/engines/chart-templates.md",
    "skills/xlsx/engines/chart.md",
    "skills/xlsx/engines/design.md",
    "skills/xlsx/engines/vba-templates.md",
    "skills/xlsx/env_setup/env_check.sh",
    "skills/xlsx/env_setup/font_list.txt",
    "skills/xlsx/env_setup/setup.md",
    "skills/xlsx/env_setup/setup_mac_linux.sh",
    "skills/xlsx/env_setup/setup_windows.ps1",
    "skills/xlsx/quality/pipeline.md",
    "skills/xlsx/scenes/advanced.md",
    "skills/xlsx/scenes/analyze-recipes.md",
    "skills/xlsx/scenes/analyze.md",
    "skills/xlsx/scenes/convert.md",
    "skills/xlsx/scenes/create.md",
    "skills/xlsx/scenes/edit-patterns.md",
    "skills/xlsx/scenes/edit.md",
    "skills/xlsx/scenes/finance.md",
    "skills/xlsx/scenes/finance_lite.md",
    "skills/xlsx/scenes/vba.md",
    "skills/xlsx/setup.sh",
    "skills/xlsx/templates/base.py",
    "skills/xlsx/templates/palettes.py",
    "skills/xlsx/xlsx.py",
  ],
  "skill-creator-plugin": [],
  "plugin-creator-plugin": [
    "skills/plugin-creator/SKILL.md",
    "skills/plugin-creator/scripts/create-basic-plugin.mjs",
    "skills/plugin-creator/scripts/marketplace-files.mjs",
    "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
    "skills/plugin-creator/scripts/scaffold-files.mjs",
    "skills/plugin-creator/scripts/validate-plugin.mjs",
    "skills/plugin-creator/references/plugin-json-spec.md",
    "skills/plugin-creator/references/installing-and-updating.md",
  ],
  "image-search-plugin": [".mcp.json"],
  "restore-legacy-sessions-plugin": [
    "commands/restore-legacy-sessions.md",
    "skills/restore-legacy-sessions/SKILL.md",
    "skills/restore-legacy-sessions/scripts/restore-conversation.mjs",
    "skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs",
  ],
  "zcode-guide-plugin": [
    "commands/workflow.md",
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/examples.md",
    "skills/dynamic-workflows/patterns.md",
  ],
  "zcode-cua-plugin": [
    "docs/computer-use.md",
    "scripts/computer-use-client.mjs",
    "scripts/computer-use-errors.mjs",
    "scripts/computer-use-envelope.mjs",
    "scripts/computer-use-keys.mjs",
    "scripts/computer-use-target.mjs",
    "skills/computer-use/SKILL.md",
  ],
} as const;

export interface BuiltinPluginAsset {
  directory: keyof typeof BUILTIN_PLUGIN_SEED_PATHS;
  packageName: string;
  relativePath: string;
  stagedPath: string;
  requiredSeedPaths: readonly string[];
  requiresRuntime: boolean;
  requiredRuntimePaths: readonly string[];
  runtimeBuildScript: string;
}

/**
 * 打包期生成运行时用的脚本（相对插件根目录），`requiresRuntime` 以此为唯一依据。
 *
 * 为什么需要这张表：`bootstrap:with-remote` 的等价构建路径会在插件目录里先跑 `tsc`，
 * 再 `node <runtimeBuildScript>`；脚本名必须真实存在。node-repl-host 与 browser-use
 * 用 `scripts/build.mjs`，而 android / ios emulator 两个插件的打包脚本叫
 * `scripts/build-mcp.mjs`（esbuild 把 `src/mcp/server.ts` 打成自包含的 `dist/mcp/server.js`）。
 * 不加这两个插件的话，它们的 seed 清单里的 `dist/mcp/server.js` 永远不会被构建。
 */
const RUNTIME_BUILD_SCRIPTS: Partial<Record<keyof typeof BUILTIN_PLUGIN_SEED_PATHS, string>> = {
  "browser-use-plugin": "scripts/build.mjs",
  "node-repl-host": "scripts/build.mjs",
  "android-emulator-plugin": "scripts/build-mcp.mjs",
  "ios-simulator-plugin": "scripts/build-mcp.mjs",
};

export const BUILTIN_PLUGIN_ASSETS: readonly BuiltinPluginAsset[] = (
  Object.keys(BUILTIN_PLUGIN_SEED_PATHS) as Array<keyof typeof BUILTIN_PLUGIN_SEED_PATHS>
).map((directory) => {
  const runtimeBuildScript = RUNTIME_BUILD_SCRIPTS[directory];
  const requiresRuntime = runtimeBuildScript !== undefined;
  return {
    directory,
    packageName: `@zcode/${directory}`,
    relativePath: `apps/zcode-cli/packages/${directory}`,
    stagedPath: `packages/${directory}`,
    requiredSeedPaths: BUILTIN_PLUGIN_SEED_PATHS[directory],
    requiresRuntime,
    requiredRuntimePaths: requiresRuntime ? BUILTIN_PLUGIN_SEED_PATHS[directory] : [],
    runtimeBuildScript: runtimeBuildScript ?? "scripts/build.mjs",
  };
});

export const BUILTIN_PLUGIN_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcodium-plugin",
  "README.md",
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
] as const;

export const BUILTIN_PLUGIN_REQUIRED_PATHS: readonly string[] = BUILTIN_PLUGIN_ASSETS.flatMap(
  ({ directory, requiredSeedPaths }) =>
    [".zcodium-plugin/plugin.json", ...requiredSeedPaths].map((path) => `${directory}/${path}`),
);
