import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/**
 * Draft release 的首段固定为本仓库的立意句。
 *
 * 出处：王勃《滕王阁序》 —— 「老当益壮，宁移白首之心？穷且益坚，不坠青云之志。」
 * 英文为该句的英译，非某一特定译者的定本。
 * 排版约定：中文在前，空行，英文在后。
 */
const RELEASE_MESSAGE_HEADING =
  "老当益壮，宁移白首之心？穷且益坚，不坠青云之志。\n" +
  "——王勃《滕王阁序》\n\n" +
  "Age may advance, yet ambition shall not wane;\n" +
  "Hardship may deepen, yet aspiration shall remain.";
const RELEASE_MESSAGE_BODY =
  "macOS arm64/x64, Linux x64/arm64 and Windows x64/arm64. Unsigned builds; review and test each platform before publishing. Verify downloads with SHA256SUMS.";
// electron-builder 按发行格式改写 ${arch}，必须匹配实际产物而非统一猜测 x64。
// macOS 同时发 arm64 与 x64（Intel），两者各自在原生 runner 上构建（macos-15 /
// macos-15-intel）：交叉架构打包会混入错误架构的原生预编译产物
// （node-pty prebuild、bundled 工具链）。dmg 面向人工安装，zip 面向自动化分发。
// Linux arm64 与 x64 的产物名差异来自 builder-util 的 getArtifactArchName：
// AppImage/deb 用 arm64，rpm 与 pacman 用 aarch64；已由本地 linux arm64 打包实测确认。
const extensions = {
  mac: [
    { extension: "dmg", arch: "arm64" },
    { extension: "zip", arch: "arm64" },
    { extension: "dmg", arch: "x64" },
    { extension: "zip", arch: "x64" },
  ],
  linux: [
    { extension: "AppImage", arch: "x86_64" },
    { extension: "deb", arch: "amd64" },
    { extension: "rpm", arch: "x86_64" },
    { extension: "pkg.tar.zst", arch: "x64" },
    { extension: "AppImage", arch: "arm64" },
    { extension: "deb", arch: "arm64" },
    { extension: "rpm", arch: "aarch64" },
    // pacman 的 arm64 名是 aarch64 而不是 arm64：builder-util 的 getArtifactArchName
    // 按 target 名（pacman）而非文件扩展名判定，x64 不在其特例表里所以保持 x64，
    // arm64 命中 pacman/rpm/flatpak 一律 aarch64。已由 linux arm64 构建实测确认。
    { extension: "pkg.tar.zst", arch: "aarch64" },
  ],
  win: [
    // Windows 同时发 x64 与 arm64：electron-builder 可在 x64 runner 上交叉构建 arm64，
    // 原生库 @trycua/cua-driver-win32-arm64-msvc 已随 SDK 的 optionalDependencies 分发。
    { extension: "exe", arch: "x64" },
    { extension: "exe", arch: "arm64" },
  ],
};
const number = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`,
);

function validateVersion(version) {
  if (typeof version !== "string" || version !== version.trim() || !versionPattern.test(version)) {
    throw new Error(`Unsupported release version: ${version}`);
  }
}

export function validateTag(tag, version) {
  validateVersion(version);
  if (tag !== `v${version}`) throw new Error(`Expected tag v${version}, received ${tag}`);
}

// 同一架构在不同产物格式里的写法不同（deb=amd64、AppImage/rpm=x86_64、exe=x64），
// 按架构族过滤时必须归一，否则 "x64" 匹配不到 Linux 的 deb/AppImage。
const ARCH_ALIASES = {
  x64: ["x64", "amd64", "x86_64"],
  arm64: ["arm64", "aarch64"],
};

export function artifactNames(platform, version, arch) {
  validateVersion(version);
  if (!Object.hasOwn(extensions, platform)) throw new Error(`Unsupported platform: ${platform}`);
  const aliases = arch ? ARCH_ALIASES[arch] : undefined;
  if (arch && !aliases) throw new Error(`Unsupported ${platform} architecture: ${arch}`);
  const entries = extensions[platform].filter((entry) => !aliases || aliases.includes(entry.arch));
  if (aliases && entries.length === 0) {
    throw new Error(`Unsupported ${platform} architecture: ${arch}`);
  }
  return entries.map(
    ({ extension, arch: entryArch }) => `ZCodium-${version}-${platform}-${entryArch}.${extension}`,
  );
}

async function assertInstaller(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid or empty installer: ${file}`);
}

export async function collectArtifacts(source, destination, platform, version, arch) {
  const names = artifactNames(platform, version, arch);
  for (const name of names) await assertInstaller(join(source, name));
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length)
    throw new Error(`Artifact directory must be empty: ${destination}`);
  for (const name of names) await copyFile(join(source, name), join(destination, name));
}

export async function verifyReleaseAssets(directory, version) {
  const names = Object.keys(extensions)
    .flatMap((platform) => artifactNames(platform, version))
    .sort();
  const allowed = new Set([...names, "SHA256SUMS"]);
  for (const name of await readdir(directory)) {
    if (!allowed.has(name)) throw new Error(`Unexpected release asset: ${name}`);
  }
  const files = names.map((name) => join(directory, name));
  for (const file of files) await assertInstaller(file);
  const sums = [];
  for (const [index, file] of files.entries()) {
    const hash = createHash("sha256");
    const handle = await open(file, "r");
    try {
      for await (const chunk of handle.createReadStream()) hash.update(chunk);
    } finally {
      await handle.close();
    }
    sums.push(`${hash.digest("hex")}  ${names[index]}\n`);
  }
  const checksumFile = join(directory, "SHA256SUMS");
  await writeFile(checksumFile, sums.join(""));
  return [...files, checksumFile];
}

export async function publishDraft({ tag, repo, files, run = execFileAsync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid GitHub repository");
  const gh = (args) => run("gh", [...args, "--repo", repo], { maxBuffer: 4 * 1024 * 1024 });
  // 查询失败必须阻断写入，不能把网络或鉴权故障误当成 Release 不存在。
  const { stdout } = await gh(["release", "list", "--limit", "1000", "--json", "tagName,isDraft"]);
  const existing = JSON.parse(stdout).find((release) => release.tagName === tag);
  if (existing && !existing.isDraft)
    throw new Error(`Refusing to overwrite published release ${tag}`);
  if (!existing) {
    await gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      ...(tag.includes("-") ? ["--prerelease"] : []),
      "--title",
      `ZCodium ${tag}`,
      "--generate-notes",
      "--notes",
      `${RELEASE_MESSAGE_HEADING}\n\n${RELEASE_MESSAGE_BODY}`,
    ]);
  }
  await gh(["release", "upload", tag, ...files, "--clobber"]);
}

async function main() {
  const [command, platform] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, "../..");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const artifacts = join(root, "dist", "release-assets");
  if (command === "check-version") {
    validateVersion(version);
    if (process.env.GITHUB_REF_TYPE === "tag") validateTag(process.env.GITHUB_REF_NAME, version);
    console.log(`Release version: ${version}`);
  } else if (command === "collect") {
    await collectArtifacts(
      join(root, "packages/desktop/dist"),
      artifacts,
      platform,
      version,
      process.env.ZCODE_TARGET_ARCH,
    );
  } else if (command === "publish") {
    if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF_TYPE !== "tag") {
      throw new Error("Draft releases require a tag push");
    }
    const tag = process.env.GITHUB_REF_NAME;
    validateTag(tag, version);
    const files = await verifyReleaseAssets(artifacts, version);
    await publishDraft({ tag, repo: process.env.GITHUB_REPOSITORY, files });
  } else {
    throw new Error("Usage: desktop-release.mjs check-version | collect <linux|win> | publish");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
