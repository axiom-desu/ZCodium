import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileService } from "@zcode/services/node";
import type { FileCopySource } from "../src/file-menu/contract.js";
import {
  fileSaveSuccessMessageId,
  MAX_FILE_COPY_BYTES,
  readFileCopy,
  saveFileCopy,
} from "../src/file-menu/fileCopy.js";

interface FakeFile {
  bytes: Uint8Array;
  mtimeMs: number;
  type?: "file" | "directory";
  size?: number;
}

function createSource(options: {
  file: FakeFile;
  /** 读取完成后改写文件，模拟读取期间并发修改。 */
  mutateOnRead?: (file: FakeFile) => void;
  chunkSize?: number;
}): { source: FileCopySource; readCalls: number[] } {
  const file = options.file;
  const readCalls: number[] = [];
  const source: FileCopySource = {
    async stat() {
      return {
        type: file.type ?? "file",
        size: file.size ?? file.bytes.byteLength,
        mtimeMs: file.mtimeMs,
      };
    },
    async readFileRange({ offset, length }) {
      readCalls.push(offset);
      const chunkLength = Math.min(options.chunkSize ?? length, length);
      const chunk = file.bytes.slice(offset, offset + chunkLength);
      options.mutateOnRead?.(file);
      return chunk;
    },
  };
  return { source, readCalls };
}

describe("文件另存读取（A3-lite）", () => {
  it("0 字节文件允许读取并交给保存对话框", async () => {
    const { source } = createSource({ file: { bytes: new Uint8Array(0), mtimeMs: 1 } });
    const buffer = await readFileCopy(source, "/w/empty.txt");
    expect(buffer.byteLength).toBe(0);
  });

  it("超过 50 MiB 在读取前拒绝，不分配整文件", async () => {
    let statCalls = 0;
    const source: FileCopySource = {
      async stat() {
        statCalls += 1;
        return { type: "file", size: MAX_FILE_COPY_BYTES + 1, mtimeMs: 1 };
      },
      async readFileRange() {
        throw new Error("must not read");
      },
    };
    await expect(readFileCopy(source, "/w/big.bin")).rejects.toThrow("file_too_large");
    expect(statCalls).toBe(1);
  });

  it("size 不可用时明确失败", async () => {
    const source: FileCopySource = {
      async stat() {
        return { type: "file", mtimeMs: 1 };
      },
      async readFileRange() {
        throw new Error("must not read");
      },
    };
    await expect(readFileCopy(source, "/w/unknown.bin")).rejects.toThrow("file_size_unavailable");
  });

  it("目录不是文件", async () => {
    const { source } = createSource({
      file: { bytes: new Uint8Array(0), mtimeMs: 1, type: "directory" },
    });
    await expect(readFileCopy(source, "/w/dir")).rejects.toThrow("not_a_file");
  });

  it("分块读取完整内容", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const { source, readCalls } = createSource({ file: { bytes, mtimeMs: 7 } });
    const buffer = await readFileCopy(source, "/w/big-but-ok.bin");
    expect(buffer.byteLength).toBe(bytes.byteLength);
    expect(new Uint8Array(buffer, 0, 4)).toEqual(bytes.slice(0, 4));
    expect(readCalls.length).toBe(3);
  });

  it("读取期间 size/mtime 改变时拒绝，不把截断内容当成功", async () => {
    const { source } = createSource({
      file: { bytes: new Uint8Array(8), mtimeMs: 1 },
      mutateOnRead: (file) => {
        file.mtimeMs += 1;
      },
    });
    await expect(readFileCopy(source, "/w/racing.bin")).rejects.toThrow("file_changed");
  });

  it("保存取消不是失败，也不提示已保存", async () => {
    const { source } = createSource({ file: { bytes: new Uint8Array(2).fill(1), mtimeMs: 1 } });
    const result = await saveFileCopy(source, "/w/a.txt", async () => ({
      success: false,
      canceled: true,
    }));
    expect(fileSaveSuccessMessageId(result, true)).toBeNull();
  });

  it("桌面成功提示已保存，Web 只提示下载已开始", async () => {
    const { source } = createSource({ file: { bytes: new Uint8Array(1), mtimeMs: 1 } });
    const result = await saveFileCopy(source, "/w/a.txt", async (payload) => ({
      success: true,
      name: payload.suggestedName,
    }));
    expect(result.success).toBe(true);
    expect(fileSaveSuccessMessageId(result, true)).toBe("fileActions.saved");
    expect(fileSaveSuccessMessageId(result, false)).toBe("fileActions.downloadStarted");
  });

  it("保存端口报错时抛出失败而不是静默成功", async () => {
    const { source } = createSource({ file: { bytes: new Uint8Array(1), mtimeMs: 1 } });
    await expect(
      saveFileCopy(source, "/w/a.txt", async () => ({ success: false, error: "disk_full" })),
    ).rejects.toThrow("disk_full");
  });
});

/**
 * 真实 FileService（临时目录）验证另存读取链路确实走 stat/readFileRange，
 * 而不是只对着 fake source 自证。
 */
describe("文件另存走真实 FileService（临时目录）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("读取真实文件字节并交给 saveFile；内容与磁盘一致", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-file-menu-"));
    dirs.push(dir);
    const filePath = join(dir, "notes.md");
    const content = "# 真实文件\n分块读取\n";
    await writeFile(filePath, content, "utf8");
    const fileService = createFileService();
    let saved: { data: ArrayBuffer; suggestedName: string } | undefined;
    const result = await saveFileCopy(fileService, filePath, async (payload) => {
      saved = { data: payload.data!, suggestedName: payload.suggestedName };
      return { success: true, name: payload.suggestedName };
    });
    expect(result.success).toBe(true);
    expect(saved?.suggestedName).toBe("notes.md");
    const bytes = new Uint8Array(saved!.data);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  it("真实目录不是文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-file-menu-"));
    dirs.push(dir);
    const fileService = createFileService();
    await expect(readFileCopy(fileService, dir)).rejects.toThrow("not_a_file");
  });
});
