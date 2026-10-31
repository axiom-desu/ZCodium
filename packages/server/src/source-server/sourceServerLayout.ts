import { posix } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

/**
 * 远端 Source Server 安装根的唯一定义。
 *
 * 默认根是 `$HOME/<用户级数据根>/server`，与 zcode-server-cli 的 `resolveServerLayout()`
 * 默认值同源（`ZCODE_USER_DATA_DIR_NAME`），不能在业务代码里重复写 `.zcodium*` 字面量。
 */
export const SOURCE_SERVER_DEFAULT_ROOT_READ_PATH = posix.join(
  "~",
  ZCODE_USER_DATA_DIR_NAME,
  "server",
);

export function sourceServerRootShell(rootReadPath = SOURCE_SERVER_DEFAULT_ROOT_READ_PATH): string {
  const normalized = rootReadPath.trim().replace(/\/+$/u, "");
  if (normalized.startsWith("~/")) {
    return `"$HOME/${normalized.slice(2)}"`;
  }
  return `'${normalized.replaceAll("'", `'"'"'`)}'`;
}

export function sourceServerBinShell(rootReadPath = SOURCE_SERVER_DEFAULT_ROOT_READ_PATH): string {
  return `${sourceServerRootShell(rootReadPath)}/bin/zcode`;
}

export function sourceServerRunFileReadPath(
  fileName: string,
  rootReadPath = SOURCE_SERVER_DEFAULT_ROOT_READ_PATH,
): string {
  return posix.join(rootReadPath, "run", fileName);
}

export function sourceServerFileReadPath(
  relativePath: string,
  rootReadPath = SOURCE_SERVER_DEFAULT_ROOT_READ_PATH,
): string {
  return posix.join(rootReadPath, relativePath);
}
