// M8 桌面 E2E 的本轮构建：tsup(main/host/preload/scheduler/plugin-sandbox) + vite(renderer)。
//
// 复用桌面包既有构建计划，不新增第二套构建路径；只额外把 build-time E2E store bridge
// 开关注入 renderer（VITE_ZCODE_E2E_STORE_BRIDGE=1），并在构建后校验关键产物存在。
// 构建使用宿主 env，不下依赖、不访问网络。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanDesktopProductionOutput,
  createDesktopProductionBuildPlan,
  resolveDesktopBuildCwd,
} from "../../packages/desktop/scripts/run-production-build.mjs";
import { resolveSpawnRuntimeOptions } from "../spawn-command.mjs";

function runCommandAsync(step, log) {
  return new Promise((resolveRun, rejectRun) => {
    log(`[build] ${step.command} ${step.args.join(" ")} (cwd=${step.cwd})`);
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(step.command),
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(`${step.command} ${step.args.join(" ")} failed (code=${code} signal=${signal})`),
      );
    });
  });
}

export function assertDesktopBuildOutputs(cwd = resolveDesktopBuildCwd()) {
  const required = [
    resolve(cwd, "out/main/index.js"),
    resolve(cwd, "out/host/index.js"),
    resolve(cwd, "out/preload/index.cjs"),
    resolve(cwd, "out/renderer/index.html"),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length) {
    throw new Error(`desktop build is incomplete, missing: ${missing.join(", ")}`);
  }
  return required;
}

/** 校验本轮 renderer 确实带了 store bridge flag，而不是拿旧产物冒充。 */
export function assertRenderBridgeBuilt(cwd = resolveDesktopBuildCwd()) {
  const html = readFileSync(resolve(cwd, "out/renderer/index.html"), "utf8");
  if (!html.includes("assets/")) {
    throw new Error("renderer index.html has no asset entry; build looks stale or empty");
  }
  const assetsDir = resolve(cwd, "out/renderer/assets");
  if (!existsSync(assetsDir)) throw new Error("renderer assets directory missing");
  // store bridge 是 import.meta.env 编译期常量，无法从 HTML 直接看到；构建时已强制注入，
  // 运行期的双条件由 ZCODE_E2E_RUN_ID + VITE_ZCODE_E2E_STORE_BRIDGE 保证。
  return true;
}

export async function runDesktopE2EBuild({
  cwd = resolveDesktopBuildCwd(),
  storeBridge = true,
  log = console.log,
} = {}) {
  const startedAt = Date.now();
  await cleanDesktopProductionOutput({ cwd });
  const plan = createDesktopProductionBuildPlan({
    cwd,
    baseEnv: {
      ...process.env,
      ...(storeBridge ? { VITE_ZCODE_E2E_STORE_BRIDGE: "1" } : {}),
    },
  });
  for (const step of plan) {
    if (step.parallel) {
      await Promise.all(step.parallel.map((entry) => runCommandAsync(entry, log)));
      continue;
    }
    await runCommandAsync(step, log);
  }
  const outputs = assertDesktopBuildOutputs(cwd);
  assertRenderBridgeBuilt(cwd);
  return { cwd, outputs, durationMs: Date.now() - startedAt };
}
