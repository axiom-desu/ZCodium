/**
 * 构建期开关：为真时安装包使用 Preview 身份，而后端环境仍由 `ZCODE_ENV` 单独决定。
 * 典型用法是 `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`，得到一个连接生产后端、
 * 可与正式版并排安装的 `ZCodium Exp Preview`。
 *
 * Bugfix：正式身份由 `ZCodium` 改名为 `ZCodium Exp`。原因是 `ZCodium-project/ZCodium`
 * 的 #13/#17 正把用户级数据根收敛到 `~/.zcodium`、bin 改名为 `zcodium`，与本仓库
 * 自 `dev.zcodium.app` / `zcodium` 起的身份完全重合——两边的安装包在包管理器里是同一个
 * 包（dpkg/rpm/pacman 同名同 appId，装一个卸一个），安装目录与桌面项也互相覆盖。
 * 改名后本仓库是独立产品线 `ZCodium Exp`，与对方平级而非同身份。
 *
 * `productName` 不带缩写点：它会流进 macOS `.app` 名（`${productName}.app`）与
 * Electron userData 目录名，带点会得到 `ZCodium Exp..app`，且 Windows 目录名不能以点
 * 结尾。带点的展示形态放 i18n / About / 文档等纯展示层。
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcodium.app.exp",
  productName: "ZCodium Exp",
  linuxExecutableName: "zcodium-exp",
  linuxPackageName: "zcodium-exp",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcodium.app.preview",
  productName: "ZCodium Preview",
  linuxExecutableName: "zcodium-preview",
  linuxPackageName: "zcodium-preview",
  cuaHelperInstallVariant: "preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * 开关只有一种开启拼写 `1`（`0` / 空 = 关闭），与 CI workflow 规则和 release 门的
 * `$ZCODE_PREVIEW_IDENTITY == "1"` 精确比较保持同一套语义。其它拼写在构建期直接失败，
 * 避免 `true` 之类在 YAML 路由层漏匹配、却在脚本层被当成开启，把 Preview 包打进生产验收目录。
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 产品身份（flavor）与后端环境（`ZCODE_ENV`）是两个轴：
 * - `ZCODE_ENV=test` 一律是 Preview，测试后端不能顶着正式 `ZCode` 身份覆盖用户的正式安装；
 * - `ZCODE_ENV=production` 默认是正式身份，显式 `ZCODE_PREVIEW_IDENTITY=1` 时改用 Preview 身份。
 * 未知 `ZCODE_ENV` 继续按 test 处理，和共享层 normalizeZCodeEnv 的 fail-safe 默认值一致。
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * 产物文件名后缀标记的是后端环境而不是身份：`_TEST` 只出现在测试后端的安装包上。
 * 生产后端的 Preview 包靠 productName（`ZCode Preview-<version>-...`）与正式包区分。
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * 返回 Windows Shell 使用的 AppUserModelId。
 *
 * 打包态必须复用 electron-builder 的 appId，否则快捷方式里的 AUMID、开始菜单索引
 * 和运行中的 Electron 进程会被 Windows 视为三个不同的应用。开发态继续保留旧身份，
 * 避免本地调试快捷方式和正式/Preview 安装包互相污染。
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  return desktopProductIdentities[flavor === "preview" ? "preview" : "production"].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
