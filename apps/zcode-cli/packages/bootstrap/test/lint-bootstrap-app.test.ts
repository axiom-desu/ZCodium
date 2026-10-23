import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import type { ZCodeAppOptions, ZCodeAppRuntimeConfigInput } from "../src/app/types.js";
import { createZCodeApp } from "../src/app/create-app.js";
import { resolveAppStartupIdentity } from "../src/app/create-app-startup-identity.js";

function createEmptyRegistry(): ProviderRegistryModelSource {
  const view = { providers: [], models: [] } as unknown as ReturnType<
    ProviderRegistryModelSource["getView"]
  >;
  return {
    getModel: () => undefined,
    getProvider: () => undefined,
    getView: () => view,
    onDidChange: () => () => undefined,
    validateSelection: (selection) => ({
      code: "model-not-found",
      modelId: selection.modelId,
      ok: false,
      providerId: selection.providerId,
    }),
  };
}

test("createZCodeApp rejects a missing Provider Registry before any IO", async () => {
  await assert.rejects(
    () => createZCodeApp({} as ZCodeAppOptions),
    /createZCodeApp requires a Provider Registry/u,
  );
});

test("startup identity keeps injected session, trace and working directory", () => {
  const identity = resolveAppStartupIdentity({
    runtimeConfig: { workingDirectory: "/tmp/workspace" } as ZCodeAppRuntimeConfigInput,
    sessionId: "session-fixed" as ZCodeAppOptions["sessionId"],
    traceContext: {
      spanId: "span",
      traceId: "trace",
    } as ZCodeAppOptions["traceContext"],
    version: "9.9.9",
  });
  assert.equal(identity.appVersion, "9.9.9");
  assert.equal(identity.sessionId, "session-fixed");
  assert.equal(identity.traceContext?.traceId, "trace");
  assert.equal(identity.workingDirectory, "/tmp/workspace");
  assert.equal(typeof identity.startupStartedAt, "number");
});

test("entry surface exposes the session runtime and closes idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-bootstrap-app-"));
  try {
    const app = await createZCodeApp({
      env: {
        ...process.env,
        ZCODE_DATA_BASE_DIR: join(directory, "data"),
        ZCODE_MAILBOX_ROOT: join(directory, "mailbox"),
      },
      providerRegistry: createEmptyRegistry(),
      runtimeConfig: { workingDirectory: directory } as ZCodeAppRuntimeConfigInput,
      skipUserConfig: true,
    });
    assert.equal(typeof app.sessionId, "string");
    assert.equal(typeof app.traceId, "string");
    assert.equal(typeof app.sendInput, "function");
    assert.equal(typeof app.listMcpServers, "function");
    assert.equal(typeof app.getPluginReferenceCatalog, "function");
    assert.equal(typeof app.listDynamicWorkflowRuns, "function");
    await Promise.all([app.close?.(), app.close?.()]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
