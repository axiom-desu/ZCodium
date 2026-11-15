#!/usr/bin/env node
// 根 workspace 的构建前置：只有「dist 导出 + 有 workspace 消费者 + 不在 CLI turbo 图内」的包需要它。
//
// 为什么需要（warm cache 掩盖过的真实 CI 缺口，见 .agents/specs/ci-cold-build-order.md）：
// - apps/zcode-cli 的 turbo 图只覆盖 apps/zcode-cli/{packages,tools}，根 `packages/*` 不在其中；
// - `@zcode/session-control` 的 package.json 公开入口指向 `dist/**`（dist 被 .gitignore 忽略），
//   而 `@zcode/core`（tsc）与 `@zcode/services`（esbuild）直接 import 它；
// - 冷 runner 没有 dist 时，core 报 TS2307、server 报 Could not resolve …/contracts，
//   本地因为残留 dist 而看不到。
//
// 单一所有者：本脚本按依赖序构建这些前置。消费者（root scripts、prepare-prebuilds、CI workflow）
// 只调用这里，不各自拼 pnpm --filter。不 external、不把 exports 改成 src、不删除 dist
// （并行的打包任务可能正在读同一份共享 dist），每次都由包自己的 build 原地覆写。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runCommand } from "../spawn-command.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
// 直接解析源码（`.ts`/`src/**`）的包由消费者自己的编译器处理，不需要先构建；
// 只有 `.js`/`.d.ts`/`out` 这类「必须先产出」的入口才算前置。
const SOURCE_ENTRY_PATTERN = /\.(?:ts|tsx|mts|cts|css|json)$/u;
// `.d.ts` 是构建产物，不是源码入口。
const DECLARATION_ENTRY_PATTERN = /\.d\.[cm]?ts$/u;
const SOURCE_DIRECTORY_PATTERN = /(?:^|\/)src\//u;
const WORKSPACE_MANIFEST = "pnpm-workspace.yaml";

/** pnpm-workspace.yaml 只用到 `packages:` 下的目录 glob，因此不引 YAML 依赖。 */
function readWorkspacePatterns(root = rootDir) {
  const text = readFileSync(join(root, WORKSPACE_MANIFEST), "utf8");
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/u.test(line)) break;
    const match = /^\s*-\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;
    // 只支持本仓实际使用的 `*`（单层），不实现通用 glob。
    patterns.push(match[1].replace(/^["']|["']$/gu, ""));
  }
  return patterns;
}

function expandWorkspacePattern(pattern, root = rootDir) {
  const segments = pattern.split("/");
  let current = [root];
  for (const segment of segments) {
    if (segment === "*") {
      current = current.flatMap((dir) =>
        readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
          .map((entry) => join(dir, entry.name)),
      );
      continue;
    }
    current = current.map((dir) => join(dir, segment));
  }
  return current.filter((dir) => existsSync(join(dir, "package.json")));
}

function publicEntryTargets(manifest) {
  const targets = [];
  if (typeof manifest.main === "string") targets.push(manifest.main);
  if (typeof manifest.types === "string") targets.push(manifest.types);
  for (const value of Object.values(manifest.exports ?? {})) {
    const entries =
      typeof value === "string"
        ? [value]
        : Object.values(value ?? {}).filter((v) => typeof v === "string");
    targets.push(...entries);
  }
  return targets;
}

const isSourceEntry = (target) =>
  !DECLARATION_ENTRY_PATTERN.test(target) &&
  (SOURCE_ENTRY_PATTERN.test(target) || SOURCE_DIRECTORY_PATTERN.test(target));
const declaredDependencyNames = (manifest) =>
  new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys(manifest[field] ?? {}),
    ),
  );

/**
 * 纯推导层：返回需要先构建的根 workspace 包，按依赖序排列。
 * 只读清单，不做 IO 副作用，便于回归测试直接断言集合与顺序。
 */
export function resolveWorkspacePrerequisites({ root = rootDir } = {}) {
  const packages = new Map();
  for (const pattern of readWorkspacePatterns(root)) {
    for (const dir of expandWorkspacePattern(pattern, root)) {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (!manifest.name) continue;
      packages.set(manifest.name, {
        name: manifest.name,
        dir,
        path: relative(root, dir).split(sep).join("/"),
        build: manifest.scripts?.build,
        entryTargets: publicEntryTargets(manifest),
        dependencies: declaredDependencyNames(manifest),
      });
    }
  }

  const candidates = [...packages.values()].filter(
    (pkg) =>
      pkg.build &&
      // CLI turbo 图自己排这些包的构建序，重复构建只会浪费 CI 时间。
      !pkg.path.startsWith("apps/zcode-cli/") &&
      pkg.entryTargets.length > 0 &&
      pkg.entryTargets.every((target) => !isSourceEntry(target)),
  );

  const dependents = new Map();
  for (const pkg of packages.values()) {
    for (const dependency of pkg.dependencies) {
      if (dependency === pkg.name) continue;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), pkg.name]);
    }
  }

  const required = candidates
    .filter((pkg) => (dependents.get(pkg.name) ?? []).length > 0)
    .map((pkg) => ({ ...pkg, dependents: dependents.get(pkg.name).sort() }));

  // Kahn 拓扑排序：同层按包名稳定排序，保证计划在任意机器上一致。
  const byName = new Map(required.map((pkg) => [pkg.name, pkg]));
  const pending = new Set(byName.keys());
  const ordered = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((name) => ![...byName.get(name).dependencies].some((dep) => pending.has(dep)))
      .sort();
    if (ready.length === 0) throw new Error(`前置包依赖成环：${[...pending].sort().join(", ")}`);
    for (const name of ready) {
      ordered.push(byName.get(name));
      pending.delete(name);
    }
  }
  return ordered;
}

/** 冷 runner 上的判据：公开入口指向的产物是否真实存在（export 供回归测试直接断言冷态）。 */
export function missingArtifacts(pkg) {
  return pkg.entryTargets.filter((target) => !existsSync(join(pkg.dir, target)));
}

/** 消费者入口（脚本/workflow）都走这里，保证顺序与失败语义只有一份实现。 */
export function buildWorkspacePrerequisites({ root = rootDir, plan } = {}) {
  const prerequisites = plan ?? resolveWorkspacePrerequisites({ root });
  for (const pkg of prerequisites) {
    console.log(`[workspace-prerequisites] build ${pkg.name} (${pkg.path})`);
    runCommand("pnpm", ["--filter", pkg.name, "run", "build"], {
      cwd: root,
      env: process.env,
    });
    const missing = missingArtifacts(pkg);
    if (missing.length > 0)
      throw new Error(
        `${pkg.name} 构建后仍缺产物：${missing.join(", ")}（检查其 exports 与 build 脚本）`,
      );
  }
  return prerequisites;
}

function describePlan(prerequisites) {
  return prerequisites.map((pkg) => ({
    name: pkg.name,
    path: pkg.path,
    build: pkg.build,
    dependents: pkg.dependents,
  }));
}

function main(argv) {
  const [mode] = argv;
  const prerequisites = resolveWorkspacePrerequisites();
  if (mode === "--plan") {
    console.log(JSON.stringify(describePlan(prerequisites), null, 2));
    return;
  }
  if (mode === "--check") {
    const missing = prerequisites.flatMap((pkg) =>
      missingArtifacts(pkg).map(
        (target) => `${pkg.name}: ${pkg.path}/${target.replace(/^\.\//u, "")}`,
      ),
    );
    if (missing.length > 0) {
      throw new Error(
        `冷态缺少前置产物（先运行 pnpm build:workspace-prerequisites）：\n${missing.join("\n")}`,
      );
    }
    console.log(
      `[workspace-prerequisites] ok: ${prerequisites.map((pkg) => pkg.name).join(", ") || "无前置"}`,
    );
    return;
  }
  buildWorkspacePrerequisites({ plan: prerequisites });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[workspace-prerequisites] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
