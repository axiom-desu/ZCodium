// 协议边界反复用到的 unknown 收窄。放在一处是为了让 mapper/projection 不各写一份
// 略有差异的实现（历史上三种 asRecord 对数组/空值的判定并不一致）。
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function stringField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}
