// 纯工具函数和常量，从 fileDisplay.tsx 提取以控制文件行数

export const DEFAULT_FILE_ICON_NAME = "document";

const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

// material-icons 里的图标名和文件扩展名并不总是一一对应，
// 比如 tsx 实际素材叫 react_ts 而不是 react_tsx。这里集中做 alias，避免 mention panel 和输入框 token 出现扩展名对不上图标的问题。
const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: "document",
  bash: "console",
  cjs: "javascript",
  cts: "typescript",
  css: "css",
  // Office 扩展名与 Material Icons 素材名不一致，直接用扩展名拼路径会选错图标；
  // 这里显式收敛到同一套产品语义，旧版与新版 Word 文件也共用 word 图标。
  doc: "word",
  docx: "word",
  go: "go",
  html: "html",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "audio",
  opus: "audio",
  mts: "typescript",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sql: "database",
  sh: "console",
  snap: "snapcraft",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function trimTrailingSeparator(path: string): string {
  return path.replace(/\/+$/, "");
}

export function resolveIconName(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  const lastSlash = normalizedPath.lastIndexOf("/");
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf(".");
  const fileNameWithoutExtension =
    lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const fileNameAliasCandidates = new Set<string>([normalizedLeaf, fileNameWithoutExtension]);

  // 之前只会匹配完整文件名和"去掉最后一个扩展名"的结果，
  // 像 vitest.config.ts / tsconfig.base.json / .env.local 这类多段文件名会提前退回扩展名图标，
  // 导致配置文件语义丢失。这里逐段回退 stem，让常见配置文件能稳定命中更准确的图标。
  let stemCandidate = fileNameWithoutExtension;
  while (stemCandidate.includes(".")) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf("."));
    if (stemCandidate) {
      fileNameAliasCandidates.add(stemCandidate);
    }
  }

  for (const candidate of fileNameAliasCandidates) {
    const aliasedFileName = FILE_NAME_ICON_ALIASES[candidate];
    if (aliasedFileName) {
      return aliasedFileName;
    }
  }

  if (lastDot === -1) {
    return DEFAULT_FILE_ICON_NAME;
  }

  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ICON_ALIASES[extension] ?? extension ?? DEFAULT_FILE_ICON_NAME;
}
