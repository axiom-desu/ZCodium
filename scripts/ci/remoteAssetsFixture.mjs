import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { remoteComponentRequiredPaths } from "../bundle-remote-assets.mjs";
import { packSourceAsDeterministicTarGzip } from "../deterministic-tar-archive.mjs";
export const platform = "linux-x64";
export const version = "3.14.0";
export async function createRemoteAssetFixture(
  t,
  contentForPath = () => "fixture",
  fixtureVersion = version,
) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-remote-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, "releases", fixtureVersion);
  const mounts = {
    "server-bundle": "server",
    "node-runtime": `node/${platform}`,
    "node-pty": `node-pty/${platform}`,
    glm: `glm/${platform}`,
    bfs: `tools/${platform}/bfs`,
    ripgrep: `tools/${platform}/ripgrep`,
    ugrep: `tools/${platform}/ugrep`,
  };
  const components = [];
  for (const [id, mount] of Object.entries(mounts)) {
    const source = join(release, mount);
    for (const path of remoteComponentRequiredPaths(id)) {
      const file = join(source, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contentForPath(id, path));
      if (path === "node") await chmod(file, 0o755);
    }
    const artifactPath = `components/${platform}/${id}/v1.tar.gz`;
    await mkdir(dirname(join(root, artifactPath)), { recursive: true });
    packSourceAsDeterministicTarGzip(source, join(root, artifactPath));
    const sha256 = createHash("sha256")
      .update(await readFile(join(root, artifactPath)))
      .digest("hex");
    components.push({ id, version: `v1+${sha256.slice(0, 12)}`, sha256, mount, artifactPath });
  }
  const manifest = {
    schemaVersion: 1,
    appVersion: fixtureVersion,
    platformArch: platform,
    components,
  };
  const manifestPath = join(release, `manifest-${platform}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  // 旧组件 fixture 也必须携带 R3；生产 bundle 不再接受旧 manifest 独立成功。
  const r3Source = join(root, "r3-source");
  await mkdir(join(r3Source, "zcode-server-linux-x64"), { recursive: true });
  await writeFile(join(r3Source, "zcode-server-linux-x64", "manifest.json"), "{}\n");
  const fileName = "zcode-server-linux-x64.tar.gz";
  packSourceAsDeterministicTarGzip(r3Source, join(release, fileName));
  const r3Bytes = await readFile(join(release, fileName));
  await writeFile(
    join(release, "source-server-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: fixtureVersion,
      archives: [
        {
          target: platform,
          version: fixtureVersion,
          fileName,
          sizeBytes: r3Bytes.length,
          sha256: createHash("sha256").update(r3Bytes).digest("hex"),
          urls: [fileName],
        },
      ],
    }),
  );
  const options = {
    sourceDirectory: root,
    outputDirectory: join(root, "bundle"),
    version: fixtureVersion,
    sourceCommit: "1".repeat(40),
  };
  return { root, manifest, manifestPath, options };
}
