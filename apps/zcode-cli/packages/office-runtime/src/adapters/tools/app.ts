import { z } from "zod";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from "#office/contract.ts";
import type { createDocumentImporter } from "#office/adapters/files.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { describeDocument, describeSnapshot, type Register } from "./shared.ts";
import { FILES_NOUN } from "#office/wording.ts";

export function registerAppTools(
  register: Register,
  owner: DocumentOwner,
  importer: ReturnType<typeof createDocumentImporter> | undefined,
) {
  if (importer) {
    register(
      "begin_file_import",
      {
        description:
          "Begin importing a file explicitly selected by the user into a workspace copy.",
        input: {
          name: z.string().min(1).max(255),
          size: z.number().int().min(1).max(MAX_FILE_BYTES),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ name, size }) => ({
        text: "Import started",
        structured: { id: await importer.begin(name, size) },
      }),
    );
    register(
      "write_file_import",
      {
        description: "Append a selected file chunk at its expected offset.",
        input: {
          id: z.string().uuid(),
          offset: z.number().int().min(0),
          data: z
            .string()
            .max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id, offset, data }) => {
        await importer.chunk(id, offset, Buffer.from(data, "base64"));
        return { text: "Chunk imported" };
      },
    );
    register(
      "finish_file_import",
      {
        description: "Finish a selected file import and return the workspace copy path.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => ({
        text: "Import complete",
        structured: { path: await importer.finish(id) },
      }),
    );
    register(
      "cancel_file_import",
      {
        description: "Remove an incomplete file import.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => {
        await importer.cancel(id);
        return { text: "Import cancelled" };
      },
    );
  }

  // Panel-only tools.
  register(
    "list_documents",
    {
      description: `List ${FILES_NOUN} in the workspace for the viewer's file picker.`,
      input: { limit: z.number().int().min(1).max(1000).optional() },
      visibility: ["app"],
    },
    async ({ limit }) => {
      const documents = await owner.list(limit ?? 500);
      return { text: `${documents.length} documents`, structured: { documents } };
    },
  );

  register(
    "load_document",
    {
      description:
        "Load a document for rendering in the viewer: returns its info and a handle to read the bytes.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const loaded = await owner.load(path);
      return { text: describeDocument(loaded.info, 10), structured: { ...loaded } };
    },
  );

  register(
    "check_document",
    {
      description:
        "Return a document's current revision so the viewer can tell when the file changed on disk.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const info = await owner.info(path);
      return { text: info.revision, structured: { path: info.path, revision: info.revision } };
    },
  );

  register(
    "get_viewer",
    {
      description: "Return the document the viewer should show (set by the agent or the user).",
      input: {},
      visibility: ["app"],
    },
    async () => {
      const snapshot = owner.snapshot();
      return { text: describeSnapshot(snapshot, "Viewer has"), structured: { ...snapshot } };
    },
  );

  register(
    "report_view",
    {
      description: "Record the user's current location and selection in the viewer.",
      input: {
        viewId: z.string().min(1).max(300).optional(),
        path: z.string().min(1).max(1000),
        at: z.string().max(300).nullable().optional(),
        selection: z
          .object({ at: z.string().min(1).max(300), text: z.string().max(20000) })
          .nullable()
          .optional(),
      },
      visibility: ["app"],
      readOnly: false,
    },
    async (input) => {
      const view = await owner.report(input);
      return { text: "ok", structured: { view } };
    },
  );

  register(
    "release_view",
    {
      description: "Release a viewer report when its page leaves.",
      input: { viewId: z.string().min(1).max(300) },
      visibility: ["app"],
      readOnly: false,
    },
    async ({ viewId }) => {
      owner.releaseView(viewId);
      return { text: "ok" };
    },
  );
}
