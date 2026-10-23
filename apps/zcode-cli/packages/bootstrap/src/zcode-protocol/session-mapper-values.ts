// mapper 侧的宽松 record 视图：与 record-values.ts 的 asRecord 不同——
// 这里刻意接受数组（协议 payload 既有的数组形态要原样透出），改它会影响
// mapSessionEventPayload 的透传语义，因此单列一份而不是复用协议守卫。
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
