import type { DataSyncListItem } from "@zcode/shared";

/**
 * 弹窗内哈希缓存（性能措施 5）：签名不变的项复用上次的哈希；推送涉及的目标项在推送后失效。
 * 没有签名的条目（JSON 类，例如 MCP）哈希很便宜，不进缓存：否则签名恒为空，本机编辑后仍会命中旧哈希。
 */
export type DataSyncHashCache = Map<string, { signature: string; hash: string }>;

function dataSyncItemSignature(item: DataSyncListItem): string {
  return item.signature ? `${item.signature.fileCount}:${item.signature.totalBytes}` : "";
}

/** 返回缓存命中的哈希和仍需向服务请求的 key。 */
export function readDataSyncHashCache(
  cache: DataSyncHashCache,
  items: readonly DataSyncListItem[],
  keys: readonly string[],
): { hashes: Record<string, string>; missing: string[] } {
  const signatureByKey = new Map(items.map((item) => [item.key, dataSyncItemSignature(item)]));
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const signature = signatureByKey.get(key);
    const cached = signature ? cache.get(key) : undefined;
    if (cached && cached.signature === signature) hashes[key] = cached.hash;
    else missing.push(key);
  }
  return { hashes, missing };
}

export function writeDataSyncHashCache(
  cache: DataSyncHashCache,
  items: readonly DataSyncListItem[],
  hashes: Readonly<Record<string, string>>,
): void {
  const signatureByKey = new Map(items.map((item) => [item.key, dataSyncItemSignature(item)]));
  for (const [key, hash] of Object.entries(hashes)) {
    const signature = signatureByKey.get(key);
    if (signature) cache.set(key, { signature, hash });
  }
}

/** 一个分类一份缓存；没有时创建。 */
export function ensureDataSyncHashCache(
  store: Map<string, DataSyncHashCache>,
  categoryId: string,
): DataSyncHashCache {
  let cache = store.get(categoryId);
  if (!cache) {
    cache = new Map();
    store.set(categoryId, cache);
  }
  return cache;
}
