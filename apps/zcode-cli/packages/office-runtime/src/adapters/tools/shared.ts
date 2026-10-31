import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OfficeError,
  PANEL_URI,
  SERVER_NAME,
  SURFACE_ID,
  type DocKind,
  type DocumentInfo,
  type ViewerSnapshot,
} from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import { EXAMPLE_ANCHORS, TITLE } from "#office/wording.ts";

type Visibility = ("model" | "app")[];

export const KIND_NAMES: Record<DocKind, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
  pdf: "PDF",
};
const UNIT_NAMES: Record<DocKind, string> = {
  docx: "blocks",
  xlsx: "sheets",
  pptx: "slides",
  pdf: "pages",
};
const LOCATION_HELP: Record<DocKind, string> = {
  docx: "Locations: p:N (paragraph), p:N-M, t:N (table), t:N/rRcC (table cell).",
  xlsx: "Locations: Sheet, Sheet!A1, Sheet!A1:D20 (quote names with spaces: 'Q3 data'!A1).",
  pptx: "Locations: slide:N, slide:N-M, slide:N/shape:ID.",
  pdf: "Locations: page:N, page:N-M.",
};

/** Model-facing summary of a document: what it is, its outline and how to address it. */
export function describeDocument(info: DocumentInfo, outlineLimit = 60): string {
  const lines = [
    `${info.path}: ${KIND_NAMES[info.kind]}, ${info.units} ${UNIT_NAMES[info.kind]}, ${(info.bytes / 1024).toFixed(0)} KiB, revision ${info.revision}.`,
  ];
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.outline.length) {
    lines.push(info.kind === "xlsx" ? "Sheets:" : info.kind === "pptx" ? "Slides:" : "Outline:");
    for (const item of info.outline.slice(0, outlineLimit))
      lines.push(
        `${"  ".repeat(Math.max(0, item.level - 1))}- ${formatAnchor(info.path, item.at)}  ${item.label}`,
      );
    if (info.outline.length > outlineLimit)
      lines.push(`  … ${info.outline.length - outlineLimit} more`);
  }
  lines.push(LOCATION_HELP[info.kind]);
  return lines.join("\n");
}

export function describeSnapshot(snapshot: ViewerSnapshot, verb: string): string {
  if (!snapshot.document) return `The ${TITLE} viewer has no document open.`;
  const parts = [`${verb} ${snapshot.document.path} in the ${TITLE} panel.`];
  if (snapshot.reveal?.targets.length)
    parts.push(
      `Showing: ${snapshot.reveal.targets.map((target) => formatAnchor(snapshot.document!.path, target.at) + (target.quote ? ` ("${target.quote}")` : "")).join(", ")}.`,
    );
  parts.push(
    "",
    describeDocument(snapshot.document),
    "",
    "Use read_document to read content; the user sees the rendered file in the panel.",
  );
  return parts.join("\n");
}

/** Tool results leave the server well formed even if a document's own text is broken. */
const textResult = (text: string, structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: wellFormed(text) }],
  ...(structuredContent ? { structuredContent: wellFormedDeep(structuredContent) } : {}),
});

export function createRegister(server: McpServer) {
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    config: {
      description: string;
      input: Shape;
      visibility: Visibility;
      /** Route results to the panel (and open it when `openPanel`). */
      panel?: boolean;
      openPanel?: boolean;
      readOnly?: boolean;
    },
    execute: (
      input: z.infer<z.ZodObject<Shape>>,
    ) => Promise<{ text: string; structured?: Record<string, unknown> }>,
  ) => {
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: config.readOnly ?? true },
        _meta: {
          ui: config.panel
            ? { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: config.visibility }
            : { visibility: config.visibility },
          ...(config.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}),
        },
      },
      (async (input: z.infer<z.ZodObject<Shape>>) => {
        try {
          const { text, structured } = await execute(input);
          return textResult(text, structured);
        } catch (error) {
          const code = error instanceof OfficeError ? error.code : "corrupt_file";
          const message = error instanceof Error ? error.message : String(error);
          if (!(error instanceof OfficeError))
            process.stderr.write(
              `[${SERVER_NAME}] ${name}: ${(error as Error)?.stack ?? message}\n`,
            );
          return {
            isError: true,
            ...textResult(`[${code}] ${message}`, { error: { code, message } }),
          };
        }
      }) as never,
    );
  };

  return register;
}

export type Register = ReturnType<typeof createRegister>;

export function createAnchor() {
  const anchor = z
    .string()
    .min(1)
    .max(1200)
    .describe(
      `Document anchor: <workspace-relative path>#<location>, e.g. ${EXAMPLE_ANCHORS}. Omit #<location> for the whole document.`,
    );

  return anchor;
}
