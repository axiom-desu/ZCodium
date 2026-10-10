// Run with node --import tsx. Export the exact schemas consumed by Rust's cold Node projection.
import { readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  conversationInputIntentSchema,
  errorAttributionSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
} from "../packages/shared/src/zcode-protocol-v4/index.ts";
import { completedToolPartMetadataSchema } from "../apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts";

const v4 = (schema) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
const v3 = (schema) =>
  zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema2019-09",
    postProcess: (json, def) => {
      if (json && def?.typeName === "ZodObject" && def.catchall?._def.typeName === "ZodNever") {
        delete json.additionalProperties;
        if (def.unknownKeys === "strict") json.additionalProperties = false;
        if (def.unknownKeys === "passthrough") json.additionalProperties = {};
      }
      for (const [flag, bound] of [
        ["exclusiveMinimum", "minimum"],
        ["exclusiveMaximum", "maximum"],
      ]) {
        if (json?.[flag] === true) {
          json[flag] = json[bound];
          delete json[bound];
        }
      }
      return json;
    },
  });
const data = {
  conversationInputIntent: v4(conversationInputIntentSchema),
  errorAttribution: v4(errorAttributionSchema),
  workflowLaunchMeta: v4(workflowLaunchMetaSchema),
  workflowNotificationMeta: v4(workflowNotificationMetaSchema),
  completedToolPartMetadata: v3(completedToolPartMetadataSchema),
};
const path = new URL(
  "../apps/zcode-cli-rust/crates/domain/schema/node-projection.json",
  import.meta.url,
);
const formatted = await format(path.pathname, `${JSON.stringify(data, null, 2)}\n`);
if (formatted.errors.length) throw new Error("Cannot format Node projection schemas");
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== formatted.code)
    throw new Error("Rust projection schema differs from TS; regenerate it");
} else await writeFile(path, formatted.code);
