import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ASSET_PREFIX,
  DOC_KINDS,
  FILE_PREFIX,
  HTML_MIME,
  PANEL_URI,
  OfficeError,
  type DocKind,
} from "#office/contract.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { isAssetName } from "#office/adapters/assets.ts";

/**
 * 只有实际执行 WebAssembly 的面板才申请宿主放宽 `wasm-unsafe-eval`。
 * pdf 使用 pdf.js 的 wasm（openjpeg/qcms），spreadsheets 使用 sheets.wasm；
 * documents/presentations 的产物没有 wasm 引用，不能顺便拿到这个能力。
 */
export function officePanelCspMeta(
  kinds: readonly DocKind[],
): { "zcode/csp": { wasmUnsafeEval: true } } | undefined {
  const needsWasm = kinds.includes("pdf") || kinds.includes("xlsx");
  return needsWasm ? { "zcode/csp": { wasmUnsafeEval: true } } : undefined;
}

export function registerResources(server: McpServer, owner: DocumentOwner, assetRoot: string) {
  // Resources: the panel, its assets and file chunks.
  const panelMeta = officePanelCspMeta(DOC_KINDS);
  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: HTML_MIME, _meta: panelMeta },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: HTML_MIME,
          text: await readFile(join(assetRoot, "panel.html"), "utf8"),
          _meta: panelMeta,
        },
      ],
    }),
  );

  server.registerResource(
    "assets",
    new ResourceTemplate(`${ASSET_PREFIX}{+name}`, { list: undefined }),
    {},
    async (uri) => {
      const name = decodeURIComponent(uri.href.slice(ASSET_PREFIX.length));
      if (!isAssetName(name))
        throw new OfficeError("invalid_resource", `Unknown UI asset: ${name}`);
      const path = join(assetRoot, name);
      if (/\.(txt|css|json|js)$/.test(name)) {
        const mimeType = name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".css")
            ? "text/css"
            : "text/plain";
        return { contents: [{ uri: uri.href, mimeType, text: await readFile(path, "utf8") }] };
      }
      const bytes = await readFile(path);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/octet-stream", blob: bytes.toString("base64") },
        ],
      };
    },
  );

  server.registerResource(
    "file",
    new ResourceTemplate(`${FILE_PREFIX}{token}/{index}`, { list: undefined }),
    {},
    async (uri, { token, index }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/octet-stream",
          blob: owner.chunk(String(token), Number(index)),
        },
      ],
    }),
  );
}
