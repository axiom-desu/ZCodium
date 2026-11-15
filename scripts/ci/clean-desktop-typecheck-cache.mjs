/**
 * Desktop 子工程的 tsc 缓存清理（G7）。
 *
 * Desktop 的 production build 会清理 `packages/desktop/out/`，而 tsc project references 也把
 * 声明写到 `out/<project>`。只删产物不删 `.tsbuildinfo` 时，`tsc -b` 会误判引用工程是最新的，
 * 报 TS6305（Output file ... has not been built from source file）。这里只清 Desktop 自己的
 * buildinfo，根包仍走增量，不会触发全量重建。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const desktop = new URL("../../packages/desktop/", import.meta.url).pathname;
const projects = ["app-navigation", "host", "main", "preload", "renderer", "scheduler"];

for (const project of projects) {
  await rm(join(desktop, `tsconfig.${project}.tsbuildinfo`), { force: true });
}
