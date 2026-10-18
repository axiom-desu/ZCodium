import { resolve, isAbsolute, join } from "node:path";
import { readFile, readdir, readlink } from "node:fs/promises";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

export function parseDebSmokeArgs(argv) {
  const options = { keep: false };
  for (const arg of argv) {
    if (arg === "--keep") options.keep = true;
    else if (arg.startsWith("--deb=")) options.deb = arg.slice(6);
    else if (arg.startsWith("--flavor=")) options.flavor = arg.slice(9);
    else if (arg.startsWith("--evidence=")) options.evidence = arg.slice(11);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  for (const key of ["deb", "evidence"]) {
    if (!options[key] || !isAbsolute(options[key]))
      throw new Error(`--${key} must be an absolute path`);
    options[key] = resolve(options[key]);
  }
  if (!Object.hasOwn(desktopProductIdentities, options.flavor))
    throw new Error("--flavor must be production or preview");
  return options;
}

export function expectedDebIdentity(flavor, architecture) {
  const identity = desktopProductIdentities[flavor];
  if (!identity) throw new Error(`unsupported flavor: ${flavor}`);
  const arch = { x64: "amd64", arm64: "arm64" }[architecture];
  if (!arch) throw new Error(`unsupported host architecture: ${architecture}`);
  return { package: identity.linuxPackageName, architecture: arch };
}

export function verifyDebIdentity(fields, flavor, architecture, expectedVersion) {
  const expected = expectedDebIdentity(flavor, architecture);
  const names = Object.keys(fields);
  if (names.some((name) => !["Package", "Version", "Architecture"].includes(name)))
    throw new Error(`unexpected deb control fields: ${names.join(", ")}`);
  for (const name of ["Package", "Version", "Architecture"])
    if (
      typeof fields[name] !== "string" ||
      !fields[name].trim() ||
      fields[name].trim().includes("\n")
    )
      throw new Error(`invalid deb control field ${name}`);
  const actual = { package: fields.Package?.trim(), architecture: fields.Architecture?.trim() };
  if (actual.package !== expected.package || actual.architecture !== expected.architecture) {
    throw new Error(
      `deb identity mismatch: expected ${expected.package}/${expected.architecture}, got ${actual.package}/${actual.architecture}`,
    );
  }
  if (typeof expectedVersion !== "string" || !expectedVersion)
    throw new Error("expected build version is required");
  // fpm 将 SemVer prerelease 分隔符转为 Debian 的 ~；必须精确对应本轮源码版本。
  if (fields.Version.trim() !== expectedVersion.replace("-", "~"))
    throw new Error(
      `deb version mismatch: expected ${expectedVersion}, got ${fields.Version.trim()}`,
    );
  return { ...actual, version: fields.Version.trim() };
}

export function appProcessId(app) {
  // Playwright 关闭连接后 process() 本身会抛错；清理不能覆盖原始验收结果。
  try {
    return app?.process()?.pid;
  } catch {
    return undefined;
  }
}

export async function readOwnDescendantCmdlines(pid, procRoot = "/proc") {
  const entries = [];
  const visited = new Set([pid]);
  const visit = async (parent) => {
    let threads;
    try {
      threads = await readdir(join(procRoot, String(parent), "task"));
    } catch {
      return;
    }
    // Linux children 按线程记录。Electron/Host 可能在非主线程 spawn，只看 task/pid
    // 会漏掉真正的 Agent，误报默认 runtime 未启动；仍只沿当前 App 的后代遍历。
    for (const tid of threads) {
      let children;
      try {
        children = await readFile(join(procRoot, String(parent), "task", tid, "children"), "utf8");
      } catch {
        continue;
      }
      for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        if (!Number.isSafeInteger(child) || child <= 0 || visited.has(child)) continue;
        visited.add(child);
        let cmdline;
        try {
          cmdline = (await readFile(join(procRoot, String(child), "cmdline")))
            .toString()
            .replaceAll("\0", " ")
            .trim();
        } catch {
          continue;
        }
        const entry = { pid: child, ppid: parent, cmdline };
        if (cmdline.includes("/rust/zcode-cli-rust")) {
          entry.exe = await readlink(join(procRoot, String(child), "exe")).catch(() => "");
        }
        // TS CLI 会把 argv 改成 process.title=zcode-cli；补充同一自有 PID 的
        // 可执行文件和两个非敏感选择字段，不读取/保存完整环境或其他用户进程。
        if (cmdline === "zcode-cli") {
          entry.exe = await readlink(join(procRoot, String(child), "exe")).catch(() => "");
          const pairs = (
            await readFile(join(procRoot, String(child), "environ")).catch(() => Buffer.alloc(0))
          )
            .toString()
            .split("\0");
          entry.electronNodeMode = pairs.includes("ELECTRON_RUN_AS_NODE=1");
          entry.runtimeSelection =
            pairs.find((pair) => pair.startsWith("ZCODE_AGENT_SERVER_RUNTIME="))?.split("=")[1] ??
            null;
        }
        entries.push(entry);
        await visit(child);
      }
    }
  };
  await visit(pid);
  return entries;
}

/** 只保留给定 Electron PID 子树里命中随包 runtime 路径的进程，避免读取其他用户进程信息。 */
export function selectPackagedRuntimeProcesses(entries, appPid, unpackRoot, flavor) {
  const descendants = new Set([appPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        changed = true;
      }
    }
  }
  const root = resolve(unpackRoot);
  const expected =
    flavor === "preview"
      ? `${root}/rust/zcode-cli-rust`
      : flavor === "production"
        ? `${root}/glm/zcode.cjs`
        : null;
  if (!expected) throw new Error(`unsupported runtime flavor: ${flavor}`);
  const ownEntries = entries.filter((entry) => descendants.has(entry.pid));
  const selected = ownEntries.filter(
    (entry) =>
      (entry.cmdline.includes(expected) && (flavor !== "preview" || entry.exe === expected)) ||
      (flavor === "production" &&
        entry.cmdline === "zcode-cli" &&
        entry.exe ===
          resolve(root, "..", desktopProductIdentities.production.linuxExecutableName) &&
        entry.electronNodeMode === true &&
        entry.runtimeSelection === "ts"),
  );
  if (
    flavor === "preview" &&
    ownEntries.some((entry) =>
      /apps\/zcode-cli-rust\/target\/(?:debug|release)/.test(entry.cmdline),
    )
  )
    throw new Error("preview runtime was overridden by TS or a development Cargo binary");
  if (
    flavor === "production" &&
    ownEntries.some((entry) =>
      /(?:^|\/)rust\/zcode-cli-rust|apps\/zcode-cli-rust\/target/.test(entry.cmdline),
    )
  )
    throw new Error("production runtime was overridden by Rust");
  if (!selected.length)
    throw new Error(`no ${flavor} runtime process at packaged path ${expected}`);
  return selected;
}
