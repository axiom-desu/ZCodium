import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tsImport } from "tsx/esm/api";
import { verifyArchiveSha256 } from "./remote-node-runtime.mjs";

const { SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME, sourceServerReleaseDescriptorSchema } =
  await tsImport("@zcode/shared", import.meta.url);
export const SOURCE_SERVER_DESCRIPTOR = SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME;

export async function containedAssetFile(directory, path) {
  const root = await realpath(directory);
  const file = await realpath(join(root, path));
  const rel = relative(root, file);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !(await stat(file)).isFile()
  ) {
    throw new Error(`Invalid Source Server asset path: ${path}`);
  }
  return file;
}

export function parseSourceServerDescriptor(value, version) {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(value);
  if (descriptor.version !== version) throw new Error("Source Server descriptor version mismatch");
  return descriptor;
}

export async function verifySourceServerAssets(directory, version) {
  const descriptor = parseSourceServerDescriptor(
    JSON.parse(
      await readFile(await containedAssetFile(directory, SOURCE_SERVER_DESCRIPTOR), "utf8"),
    ),
    version,
  );
  for (const archive of descriptor.archives) {
    const file = await containedAssetFile(directory, archive.fileName);
    if ((await stat(file)).size !== archive.sizeBytes) {
      throw new Error(`Source Server archive size mismatch: ${archive.fileName}`);
    }
    await verifyArchiveSha256(file, archive.sha256);
  }
  return descriptor;
}

export async function writeSourceServerDescriptor(directory, descriptor) {
  const path = join(directory, SOURCE_SERVER_DESCRIPTOR);
  await mkdir(directory, { recursive: true });
  await writeFile(`${path}.part`, `${JSON.stringify(descriptor, null, 2)}\n`);
  await rename(`${path}.part`, path);
}

export async function copySourceServerArchives(sourceDirectory, outputDirectory, descriptor) {
  for (const archive of descriptor.archives) {
    const source = await containedAssetFile(sourceDirectory, archive.fileName);
    const target = join(outputDirectory, archive.fileName);
    await mkdir(dirname(target), { recursive: true });
    // 直接复制归档，不能让 Windows 宿主解包后丢失远端 Node/launcher 的执行位。
    await copyFile(source, target);
    if ((await stat(target)).size !== archive.sizeBytes) {
      throw new Error(`Source Server archive size mismatch: ${archive.fileName}`);
    }
    await verifyArchiveSha256(target, archive.sha256);
  }
}
