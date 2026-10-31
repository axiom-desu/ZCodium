import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";

// 既定 3.16 行为（upstream-3.16-source-server.md「server-info 能力」）：createHttpServer 在
// 创建期用 services.getOptional 探测真实注册的 ProjectService/TaskService 来声明
// capabilities.virtualProjects / existingRuntimeAdmission，因此必须传入真实 ServiceCollection，
// 不能再传裸对象。本测试未注册任何服务，能力字段自然为 false，不影响被测的 bundle 路径语义。
const { ServiceCollection } = await tsImport(
  "../../packages/services/src/index.ts",
  import.meta.url,
);

test("Web remote connection uses the server-owned bundle path and strips client overrides", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcodium-http-assets-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "http.cjs");
  await build({
    stdin: {
      contents:
        'export { createHttpServer } from "./http.ts"; export { requests as capturedRemoteRequests } from "./remote/index.js";',
      resolveDir: resolve(import.meta.dirname, "../../packages/server/src"),
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "remote-transport-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/remote\/index\.js$/ }, () => ({
            path: "transport",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
        export const requests = [];
        export async function createRemoteBackend(target) { return { target }; }
        export async function connectRemote(backend, options) {
          requests.push({ target: backend.target, options });
          return { services: {}, dispose() {} };
        }
      `,
          }));
        },
      },
    ],
  });
  const { createHttpServer, capturedRemoteRequests } = createRequire(import.meta.url)(bundle);
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    bundledRemoteAssetsDir: "/fixture/server-owned-bundle",
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connect-remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "ssh",
      host: "fixture.invalid",
      username: "fixture",
      bundledRemoteAssetsDir: "/untrusted/client-path",
      assetInstallMode: "remote-download",
    }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).id);
  assert.deepEqual(capturedRemoteRequests, [
    {
      target: { kind: "ssh", host: "fixture.invalid", username: "fixture" },
      options: { bundledRemoteAssetsDir: "/fixture/server-owned-bundle" },
    },
  ]);
});
