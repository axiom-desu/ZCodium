export const ZCODE_PROVIDER = "glm";

export function projectIdFromPath(workspacePath) {
  // 保持和现有 CLI session project_id 约定一致。
  return "proj_" + workspacePath.replace(/^\//, "").replace(/\//g, "-");
}

export function workspaceKey(workspacePath, workspaceIdentity) {
  return (workspaceIdentity || "").trim() || workspacePath;
}

export function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function jsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function jsonText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
