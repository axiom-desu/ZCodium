import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { getNodeErrorCode } from "./path-errors.js";

class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkWriteRefusedError";
  }
}

export async function atomicWrite(path: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;

  try {
    const targetInfo = await lstat(path);
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${path}. Resolve the symlink and pass the real target path explicitly.`,
      );
    }
    existingMode = targetInfo.mode;
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标文件；必须先复制原文件权限，避免抹掉脚本执行位。
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
  } catch {
    await unlink(tempPath).catch(() => undefined);
    const fallbackHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (getNodeErrorCode(error) === "ELOOP") {
        throw new SymlinkWriteRefusedError(
          `Refusing to write through symlink: ${path} (O_NOFOLLOW)`,
        );
      }
      throw error;
    });

    try {
      await fallbackHandle.writeFile(content);
      await fallbackHandle.sync();
    } finally {
      await fallbackHandle.close();
    }
  }
}
