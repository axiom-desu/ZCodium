import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import {
  GEN_UI_HTML_MAX_BYTES,
  genUiStateTargetSchema,
  type GenUiDocument,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";

export function assertGenUiFragment(html: string): void {
  if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI file exceeds 5 MB");
  if (/<(?:!doctype\b|\/?(?:html|head|body)(?:\s|>))/iu.test(html))
    throw new Error("Gen UI requires an HTML fragment");
}
export async function readGenUiDocument(
  raw: GenUiStateTarget,
  outputRoot: string,
): Promise<GenUiDocument> {
  const input = genUiStateTargetSchema.parse(raw);
  if (!isAbsolute(input.path) || !isAbsolute(input.workspacePath))
    throw new Error("Invalid executor path");
  const root = resolve(outputRoot),
    sessionRoot = getGenUiOutputDirectory(outputRoot, {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
      sessionId: input.sessionId,
    }),
    file = normalize(input.path);
  const sessionChild = relative(sessionRoot, file);
  if (
    !sessionChild ||
    sessionChild === ".." ||
    sessionChild.startsWith(`..${sep}`) ||
    isAbsolute(sessionChild)
  )
    throw new Error("Gen UI file is outside this session output directory");
  const child = relative(root, file);
  // 修复依据：realpath 后再做前缀判断仍可能放行替换中的符号链接；逐级拒绝链接并核对打开的文件身份。
  const canonicalRoot = await realpath(root);
  getGenUiOutputDirectory(canonicalRoot, {
    workspacePath: await realpath(input.workspacePath),
    workspaceIdentity: input.workspaceIdentity,
    sessionId: input.sessionId,
  });
  let current = canonicalRoot;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Gen UI does not read symbolic links");
  }
  const before = await lstat(current);
  const canonicalFile = await realpath(current);
  const canonicalSessionRoot = join(canonicalRoot, relative(root, sessionRoot));
  const canonicalChild = relative(canonicalSessionRoot, canonicalFile);
  if (!canonicalChild || canonicalChild.startsWith(`..${sep}`) || isAbsolute(canonicalChild))
    throw new Error("Gen UI file escaped the output directory");
  if (!before.isFile() || before.size > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI requires a regular file under 5 MB");
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Gen UI file changed while opening");
    const bytes = Buffer.alloc(GEN_UI_HTML_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > GEN_UI_HTML_MAX_BYTES) throw new Error("Gen UI file exceeds 5 MB");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    assertGenUiFragment(html);
    return { path: file, html };
  } finally {
    await handle.close();
  }
}
