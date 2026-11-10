import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// 现场构建 Web profile 手机 E2E 的 fixture bundle 与 Tailwind CSS。
// 不读取 packages/desktop/out 的陈旧 renderer 资产，确保 16px token / 安全区样式来自当前源码。
// 手机用例使用真实 AnimatedSidePanePanel / WorkspaceHeader：别名只保留重型业务叶子，
// 不能再用替身面板把「外层 panel + 内层 frame」两个 DOM 契约混成一个节点。
const ALIASES = [
  "root/DiffsWorkerPoolProvider",
  "SettingsPage",
  "onboarding/OccupationOnboarding",
  "onboarding/OnboardingDialog",
  "SSHDialog",
  "DirectoryBrowser",
  "cua-permission/CuaPermissionObservationAttachment",
  "app-shell/AnimatedTerminalPanel",
  "WorkspaceSidebar",
  // 面板真实挂载后 code-viewer tab 会渲染 FileManagerPane；保留重型预览叶子替换。
  "WorkspaceFileTree",
  "v4/V4WorkspaceChatArea",
  "PreviewPane",
  "SidePaneTerminalPane",
  "browser-use/BrowserUseSidePaneContent",
  "browser-use/HumanBrowserView",
  "GitPane",
  "TreemappingPane",
  "WhiteboardPane",
  "ModelTrajectoryPane",
  "DeveloperToolsPane",
  "app-shell/SidePaneTabOverview",
  "app-shell/SubagentSessionSidePane",
  "app-shell/SubagentDirectorySidePane",
  "app-shell/SelectionSideChatPane",
  "app-shell/BackgroundBashOutputSidePane",
  "app-shell/PlanDetailSidePane",
  "app-shell/WorkflowRunSidePane",
  "app-shell/WorkflowRunDirectorySidePane",
  "app-shell/WorkflowActorSessionSidePane",
  "app-shell/WorkflowWorkspaceSidePane",
  "app-shell/WorkflowArtifactSidePane",
];

export async function buildFixtureScript(root, cacheDir) {
  const fixtureDir = resolve(root, "packages/ui/test/fixtures");
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [resolve(fixtureDir, "app-shell-full-view.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "web-profile-mobile-fixture"),
    alias: {
      "@/side-pane-full-view/index.js": resolve(
        root,
        "packages/ui/src/side-pane-full-view/index.js",
      ),
      ...Object.fromEntries(
        ALIASES.map((name) => [`@/${name}.js`, resolve(fixtureDir, "app-shell-leaves.jsx")]),
      ),
      "@": resolve(root, "packages/ui/src"),
    },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("Web profile mobile fixture bundle was not produced");
  return script;
}

export async function buildFreshUiCss(root, tempDir) {
  const webRequire = createRequire(resolve(root, "packages/web/package.json"));
  const { build } = await import(webRequire.resolve("vite"));
  const tailwindcss = (await import(webRequire.resolve("@tailwindcss/vite"))).default;
  const cssDir = resolve(tempDir, "css");
  await mkdir(cssDir, { recursive: true });
  const entry = resolve(cssDir, "entry.js");
  await writeFile(
    entry,
    `import ${JSON.stringify(resolve(root, "packages/ui/src/styles.css"))};\n`,
  );
  const result = await build({
    root: cssDir,
    configFile: false,
    plugins: [tailwindcss()],
    logLevel: "warn",
    build: {
      write: false,
      cssCodeSplit: false,
      lib: { entry, formats: ["es"], fileName: "entry" },
    },
  });
  const file = result
    .flatMap((output) => output.output ?? [])
    .find((candidate) => candidate.fileName.endsWith(".css") && candidate.type === "asset");
  if (!file?.source) throw new Error("Fresh Tailwind CSS build was not produced");
  return typeof file.source === "string" ? file.source : Buffer.from(file.source).toString();
}

export async function readWebEntry(root) {
  const raw = await readFile(resolve(root, "packages/web/index.html"), "utf8");
  // 真实 Web 入口由 main.tsx import ui/styles.css；fixture 把 .css loader 置空，
  // 因此这里补上等价的 stylesheet link，其余 HTML（入口标记、viewport、内联首帧主题）保持原样。
  const html = raw
    .replace(
      '<script type="module" src="/src/main.tsx"></script>',
      '<script type="module" src="/fixture.js"></script>',
    )
    .replace("</head>", '<link rel="stylesheet" href="/styles.css"></head>');
  if (!html.includes("/fixture.js") || !html.includes("/styles.css")) {
    throw new Error("packages/web/index.html fixture wiring was not applied");
  }
  return { raw, html };
}

export async function makeTempDirs(baseDir) {
  const tempDir = await mkdtemp(resolve(baseDir, "web-profile-mobile-"));
  const dirs = {
    tempDir,
    profileDir: resolve(tempDir, "profile"),
    homeDir: resolve(tempDir, "home"),
    xdgConfigDir: resolve(tempDir, "xdg-config"),
    xdgCacheDir: resolve(tempDir, "xdg-cache"),
  };
  for (const dir of [dirs.profileDir, dirs.homeDir, dirs.xdgConfigDir, dirs.xdgCacheDir]) {
    await mkdir(dir, { recursive: true });
  }
  return dirs;
}
