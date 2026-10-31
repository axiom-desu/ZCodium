import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PLUGIN_VERSION, SERVER_NAME } from "#office/contract.ts";
import type { createDocumentImporter } from "#office/adapters/files.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { registerResources } from "#office/adapters/resources.ts";
import { registerAppTools } from "#office/adapters/tools/app.ts";
import { registerModelTools } from "#office/adapters/tools/model.ts";
import { createAnchor, createRegister } from "#office/adapters/tools/shared.ts";

export function createOfficeServer({
  owner,
  assetRoot,
  importer,
}: {
  owner: DocumentOwner;
  assetRoot: string;
  importer?: ReturnType<typeof createDocumentImporter>;
}) {
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });
  const register = createRegister(server);
  registerModelTools(register, createAnchor(), owner);
  registerAppTools(register, owner, importer);
  registerResources(server, owner, assetRoot);
  return server;
}
