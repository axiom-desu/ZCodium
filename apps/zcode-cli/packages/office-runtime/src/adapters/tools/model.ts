import { z } from "zod";
import { OfficeError } from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { truncateBytes } from "#office/domain/model.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { KIND_NAMES, describeDocument, describeSnapshot, type Register } from "./shared.ts";
import {
  EXAMPLE_LOCATIONS,
  EXTENSIONS_OR,
  FILE_NOUN,
  QUOTE_BEST_FOR,
  READ_FORMS,
  TARGET_NOUNS,
  TITLE,
} from "#office/wording.ts";

export function registerModelTools(register: Register, anchor: z.ZodString, owner: DocumentOwner) {
  register(
    "open_document",
    {
      description: `Open a ${EXTENSIONS_OR} file from the workspace in the ${TITLE} viewer panel, which the user sees. Optionally jump to a location. Returns the document's outline and how to address locations in it. Use this when the user wants to view, review or discuss ${FILE_NOUN}.`,
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        at: z
          .string()
          .max(300)
          .optional()
          .describe(`Optional location to show, e.g. ${EXAMPLE_LOCATIONS}.`),
      },
      visibility: ["model", "app"],
      panel: true,
      openPanel: true,
    },
    async ({ path, at }) => {
      const snapshot = await owner.open(path, at);
      return { text: describeSnapshot(snapshot, "Opened"), structured: { ...snapshot } };
    },
  );

  register(
    "read_document",
    {
      description: `Read the content of a document or of one location in it as text: ${READ_FORMS}. Each block is prefixed with its location so you can cite or show it. Long results are paged: call again with the returned cursor.`,
      input: {
        anchor,
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Cursor from a previous result to continue reading."),
      },
      visibility: ["model"],
    },
    async ({ anchor: target, cursor }) => {
      const { info, at, page } = await owner.read(target, cursor ?? 0);
      const head = `${formatAnchor(info.path, at)} (${KIND_NAMES[info.kind]}, revision ${info.revision})`;
      const tail =
        page.next === null
          ? "[end]"
          : `[more: call read_document with anchor "${formatAnchor(info.path, at)}" and cursor ${page.next}]`;
      return {
        text: `${head}\n\n${page.text || "(no text)"}\n\n${tail}`,
        structured: { path: info.path, at, revision: info.revision, next: page.next },
      };
    },
  );

  register(
    "search_document",
    {
      description:
        "Find text in a document (case-insensitive). Returns matching locations as anchors with a snippet each; pass them to read_document or show_in_viewer.",
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
      },
      visibility: ["model"],
    },
    async ({ path, query, limit }) => {
      const { info, hits } = await owner.search(path, query, limit ?? 20);
      const text = hits.length
        ? [
            `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${info.path}:`,
            ...hits.map((hit) => `- ${formatAnchor(info.path, hit.at)}  ${hit.snippet}`),
          ].join("\n")
        : `No matches for "${query}" in ${info.path}.`;
      return {
        text,
        structured: {
          path: info.path,
          hits: hits.map((hit) => ({ ...hit, anchor: formatAnchor(info.path, hit.at) })),
        },
      };
    },
  );

  register(
    "show_in_viewer",
    {
      description: `Point the user at specific places in a document: the ${TITLE} panel opens the document, scrolls to the first target and highlights all targets. Use it whenever your answer refers to a particular ${TARGET_NOUNS}. All anchors must be in the same document. \`quote\` highlights that exact text inside the location (best for ${QUOTE_BEST_FOR}).`,
      input: {
        targets: z
          .array(z.object({ anchor, quote: z.string().max(500).optional() }))
          .min(1)
          .max(20),
        note: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional short caption shown in the dedicated Agent panel next to the highlight; manual document windows are not retargeted.",
          ),
      },
      visibility: ["model"],
      panel: true,
      openPanel: true,
    },
    async ({ targets, note }) => {
      const snapshot = await owner.show(targets, note);
      return { text: describeSnapshot(snapshot, "Showing"), structured: { ...snapshot } };
    },
  );

  register(
    "get_view",
    {
      description: `See what the user is looking at in the ${TITLE} panel: the open document, the visible location and the user's current selection with its text. Call this when the user says "this", "here" or "the selected …" about a document.`,
      input: {
        viewId: z
          .string()
          .max(300)
          .optional()
          .describe("Viewer ID from a previous ambiguous get_view result."),
      },
      visibility: ["model"],
    },
    async ({ viewId }) => {
      const views = owner.views();
      if (!viewId && views.length > 1)
        return {
          text:
            "Multiple document viewers have reported views. Ask the user which document they mean, then call get_view with its viewId.\n" +
            views.map((view) => `${view.viewId}: ${view.path}`).join("\n"),
          structured: { ambiguous: true, views },
        };
      if (viewId && !views.some((view) => view.viewId === viewId))
        throw new OfficeError(
          "invalid_token",
          "Unknown viewer. Call get_view without viewId to list viewers.",
        );
      const view = owner.view(viewId);
      const current = view.path ? await owner.info(view.path) : owner.current();
      if (!current && !view.path)
        return {
          text: `The ${TITLE} viewer has no document open. Use open_document to open one.`,
          structured: { view, document: null },
        };
      const path = view.path ?? current!.path;
      const lines = [`Open document: ${path}`];
      if (view.at) lines.push(`Visible location: ${formatAnchor(path, view.at)}`);
      if (view.selection) {
        lines.push(`User selection: ${formatAnchor(path, view.selection.at)}`);
        if (view.selection.text) lines.push(`Selected text: """${view.selection.text}"""`);
        if (view.kind === "xlsx") {
          // The panel shows computed values; add what the file stores (values and formulas).
          const stored = await owner.read(formatAnchor(path, view.selection.at)).catch(() => null);
          if (stored)
            lines.push(
              "Selected cells as stored in the file:",
              truncateBytes(stored.page.text, 4096),
            );
        }
      } else lines.push("No selection.");
      if (view.updatedAt)
        lines.push(
          `(reported ${Math.max(0, Math.round((Date.now() - view.updatedAt) / 1000))} s ago)`,
        );
      if (current) lines.push("", describeDocument(current, 30));
      return { text: lines.join("\n"), structured: { view, document: current } };
    },
  );
}
