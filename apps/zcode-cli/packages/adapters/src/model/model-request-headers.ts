/** 会话能力标签（上游 3.18.2 F12）。 */
const MODEL_SESSION_FEATURES_HEADER = "x-zcode-session-features";
/** 只能由调用上下文生成的受控头：provider 静态值一律剔除。 */
const MODEL_CONTEXT_OWNED_HEADER_NAMES = new Set([MODEL_SESSION_FEATURES_HEADER]);

const SESSION_FEATURE_VALUE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const SESSION_FEATURES_HEADER_MAX_LENGTH = 256;
const SESSION_FEATURES_SEPARATOR = ",";

/** 请求上下文拥有会话能力标签，不能从 Provider 静态配置继承。 */
export function withoutContextOwnedModelHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_CONTEXT_OWNED_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/**
 * 按会话能力标签生成受控请求头；去重、字典序拼接。任一标签不合法或总长超限时整头省略，
 * 避免 HTTP 头校验阻断模型请求，也不回退到静态 header。
 */
export function withModelSessionFeaturesHeader(
  headers: Readonly<Record<string, string>> | undefined,
  features: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (!features || features.length === 0) return headers ? { ...headers } : undefined;
  if (!features.every((feature) => SESSION_FEATURE_VALUE_PATTERN.test(feature))) {
    return headers ? { ...headers } : undefined;
  }
  const value = [...new Set(features)].sort().join(SESSION_FEATURES_SEPARATOR);
  if (value.length > SESSION_FEATURES_HEADER_MAX_LENGTH) {
    return headers ? { ...headers } : undefined;
  }
  const result: Record<string, string> = { ...headers };
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === MODEL_SESSION_FEATURES_HEADER) delete result[name];
  }
  result[MODEL_SESSION_FEATURES_HEADER] = value;
  return result;
}

/** HTTP 头名不区分大小写；后来的值替换旧值，避免不同大小写被 SDK 拼成重复头。 */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
