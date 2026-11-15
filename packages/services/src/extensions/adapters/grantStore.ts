import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { extensionGrantsFileSchema, type ExtensionGrantRecord } from "@zcode/shared/extension-host";

/**
 * 授权文件适配器：`grants.json` 的唯一读写点。
 *
 * - 读取：文件缺失或损坏按「没有任何授权」处理（默认拒绝），不把解析失败当成全部授权。
 * - 写入：先写同目录临时文件、chmod 0600，再原子 rename；调用方只有在 save 成功后才发布新状态。
 */
interface GrantStore {
  load(): Promise<ExtensionGrantRecord[]>;
  save(records: readonly ExtensionGrantRecord[]): Promise<void>;
}

export function createGrantStore(options: { filePath: string }): GrantStore {
  let writeChain: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(options.filePath, "utf8");
      } catch {
        return [];
      }
      try {
        const parsed = extensionGrantsFileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.records : [];
      } catch {
        return [];
      }
    },
    async save(records) {
      const run = async () => {
        await mkdir(dirname(options.filePath), { recursive: true });
        const temp = `${options.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        const payload = JSON.stringify({ v: 1, records }, null, 2);
        await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
        await chmod(temp, 0o600).catch(() => {});
        await rename(temp, options.filePath);
      };
      // 串行化写入，避免两个 UI 操作交叉 rename 导致丢授权。
      writeChain = writeChain.then(run, run);
      await writeChain;
    },
  };
}
