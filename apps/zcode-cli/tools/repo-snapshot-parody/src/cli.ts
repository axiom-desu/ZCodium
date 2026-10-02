/**
 * 入口。
 *
 * 子命令：
 *   capture    扫描 → 打包 → 加密 → 传 127.0.0.1（或留在 pending 等重试）
 *   serve       起本地接收端，打印"服务端到底收到了什么"
 *   decrypt     用本地私钥解出明文 tar.gz（原版做不到的一步）
 *   manifest    只看清单，不打包不传出任何东西
 *
 * 四个子命令全都先过开关。没启用就退出码 2，一个字节都不落盘。
 */

import { homedir } from "node:os";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import {
  PARODY_ENV_KEY,
  PARODY_FLAG,
  resolveParodyGate,
} from "./gate.js";
import { scanRepoSnapshot, workspaceKeyHash, workspaceKeyOf } from "./scan.js";
import {
  buildDelta,
  computeManifestHash,
  manifestPathFor,
  normalizeState,
  readManifest,
  readState,
  statePathFor,
  writeManifest,
  writeState,
} from "./state.js";
import { writeTarGz, type TarEntry } from "./tar.js";
import { decryptArchive, encryptArchive, openLocalVault } from "./vault.js";
import { uploadSnapshot } from "./upload.js";
import { startSnapshotServer } from "./server.js";
import type { CaptureAttribution, PendingUploadRecord, RepoSnapshotState } from "./types.js";

const STATE_DIR_ENV_KEY = "ZCODE_PARODY_STATE_DIR";
const DEFAULT_PORT = 8787;

function defaultStateDir(): string {
  return process.env[STATE_DIR_ENV_KEY]?.trim() || join(homedir(), ZCODE_USER_DATA_DIR_NAME, "repo-snapshot-parody");
}

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

/** 开关闸门。任何子命令的第一件事。 */
function requireGate(): void {
  const gate = resolveParodyGate();
  if (!gate.enabled) {
    console.error(gate.reason);
    process.exit(2);
    throw new Error("gate closed");
  }
  console.log(`[gate] 已启用（来源：${gate.source}）`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function runCapture(argv: string[]): Promise<void> {
  requireGate();

  const portIndex = argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspaceArg = argv[argv.indexOf("--workspace") + 1];
  const workspacePath = workspaceArg ?? process.cwd();

  const stateDir = defaultStateDir();
  const keysDir = join(stateDir, "keys");
  const workspacesRoot = join(stateDir, "workspaces");

  const workspaceKey = workspaceKeyOf(workspacePath);
  const workspaceHash = workspaceKeyHash(workspaceKey);
  const statePath = statePathFor(workspacesRoot, workspaceHash);

  const vault = await openLocalVault(keysDir);
  const state = normalizeState(await readState(statePath, workspacePath, workspaceKey));

  console.log(`[scan] ${workspaceKey}`);
  const { manifest, absolutePaths } = await scanRepoSnapshot(workspacePath);
  const manifestHash = computeManifestHash(manifest);
  const manifestPath = manifestPathFor(workspacesRoot, workspaceHash, manifestHash);
  await writeManifest(manifestPath, manifest);
  console.log(
    `[scan] ${manifest.stats.includedFileCount} 个文件 / ${formatBytes(manifest.stats.includedBytes)}` +
      `（来源 ${manifest.source}，hash ${manifestHash.slice(0, 12)}）`,
  );

  const gitFiles = manifest.files.filter((file) => file.path.split("/").includes(".git"));
  if (gitFiles.length > 0) {
    console.log(
      `[scan] 其中 .git：${gitFiles.length} 个文件 / ` +
        `${formatBytes(gitFiles.reduce((sum, file) => sum + file.sizeBytes, 0))}` +
        ` —— 这就是原版越界的地方，此处原样复刻`,
    );
  }

  // baseline / increment
  let kind: "baseline" | "increment" = "baseline";
  let entries: TarEntry[] = manifest.files.map((file) => ({
    path: file.path,
    absolutePath: absolutePaths.get(file.path) ?? join(workspaceKey, file.path),
    sizeBytes: file.sizeBytes,
  }));
  let baseManifestHash: string | undefined;

  if (state.lastAcceptedManifestHash && state.lastAcceptedManifestPath) {
    try {
      const baseManifest = await readManifest(state.lastAcceptedManifestPath);
      const delta = buildDelta({
        baseManifest,
        nextManifest: manifest,
        baseManifestHash: state.lastAcceptedManifestHash,
        nextManifestHash: manifestHash,
      });
      if (delta.addedOrModified.length === 0 && delta.deleted.length === 0) {
        console.log("[capture] 与上次已收录的快照一致，无事可做");
        return;
      }
      kind = "increment";
      baseManifestHash = state.lastAcceptedManifestHash;
      entries = delta.addedOrModified.map((file) => ({
        path: file.path,
        absolutePath: absolutePaths.get(file.path) ?? join(workspaceKey, file.path),
        sizeBytes: file.sizeBytes,
      }));
      console.log(
        `[capture] increment：${delta.addedOrModified.length} 增改 / ${delta.deleted.length} 删除`,
      );
    } catch {
      console.log("[capture] 上次清单读不出来，退回 baseline");
    }
  }

  const groupId = `${manifestHash}.${Date.now()}`;
  const workspaceDir = join(workspacesRoot, workspaceHash);
  const plaintextPath = join(workspaceDir, "tmp", `${groupId}.tar.gz`);
  const encryptedPath = join(workspaceDir, "pending", `${groupId}.tar.gz.enc`);
  const envelopePath = join(workspaceDir, "pending", `${groupId}.envelope.json`);

  console.log(`[archive] tar.gz → ${plaintextPath}`);
  const archived = await writeTarGz(entries, plaintextPath);
  console.log(`[archive] ${archived.fileCount} 个文件，明文 ${formatBytes(archived.plaintextBytes)}`);

  const attribution: CaptureAttribution = {
    captureStage: "parody-capture",
  };
  const prompt = {
    schema: "zcode-repo-snapshot-parity/prompt/v1",
    ...attribution,
    createdAt: Date.now(),
    manifestHash,
    kind,
  };

  console.log(`[vault] AES-256-CTR + 本地 RSA-OAEP-SHA256（keyId=${vault.keyId}）`);
  const encrypted = await encryptArchive({
    plaintextArchivePath: plaintextPath,
    encryptedArtifactPath: encryptedPath,
    envelopePath,
    vault,
    workspaceKeyHash: workspaceHash,
    kind,
    manifestHash,
    ...(baseManifestHash ? { baseManifestHash } : {}),
  });

  // 明文包用完即删，和原版一样只留密文
  await rm(plaintextPath, { force: true });

  const pending: PendingUploadRecord = {
    groupId,
    kind,
    encryptedArtifactPath: encryptedPath,
    encryptionEnvelopePath: envelopePath,
    manifestPath,
    ...(baseManifestHash ? { baseManifestHash } : {}),
    nextManifestHash: manifestHash,
    createdAt: Date.now(),
    attemptCount: 0,
  };

  let nextState: RepoSnapshotState = {
    ...state,
    activeUpload: pending,
    latestPendingUpload: pending,
    lastCompressedSize: {
      encryptedSizeBytes: encrypted.encryptedSizeBytes,
      workspaceSizeBytes: manifest.stats.includedBytes,
      manifestHash,
      recordedAt: Date.now(),
    },
  };

  try {
    console.log(`[upload] POST ${baseUrl}/snapshot`);
    const result = await uploadSnapshot({
      baseUrl,
      workspaceKeyHash: workspaceHash,
      groupId,
      encryptedArtifactPath: encryptedPath,
      envelope: encrypted.envelope,
      manifest,
      artifactBytes: encrypted.encryptedSizeBytes,
    });
    if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.responseBody}`);
    console.log(`[upload] 已接收（${result.status}）`);
    nextState = {
      ...nextState,
      lastAcceptedManifestHash: manifestHash,
      lastAcceptedManifestPath: manifestPath,
      activeUpload: undefined,
      latestPendingUpload: undefined,
    };
  } catch (error) {
    const failureCount = nextState.failureCount + 1;
    console.error(
      `[upload] 失败（failureCount=${failureCount}）：` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `  密文留在 pending/，与闭源版一样会重试。想停止就删掉它。`,
    );
    nextState = { ...nextState, failureCount };
  }

  await writeState(statePath, normalizeState(nextState));
  console.log(`[state] ${statePath}`);
}

async function runServe(argv: string[]): Promise<void> {
  requireGate();
  const portIndex = argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : DEFAULT_PORT;
  const storageDir = join(defaultStateDir(), "received");
  const instance = await startSnapshotServer({ port, storageDir });
  console.log(`[serve] 密文落盘目录：${storageDir}`);
  console.log("[serve] Ctrl-C 结束");
  await new Promise<void>((resolvePromise) => {
    process.on("SIGINT", () => {
      void instance.close().then(resolvePromise);
    });
  });
}

async function runDecrypt(argv: string[]): Promise<void> {
  requireGate();
  const dirIndex = argv.indexOf("--dir");
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
  if (!dir) fail("用法：decrypt --dir <groupId 目录>");

  const stateDir = defaultStateDir();
  const vault = await openLocalVault(join(stateDir, "keys"));
  const output = join(dir, "snapshot.tar.gz");
  await decryptArchive({
    envelopePath: join(dir, "envelope.json"),
    encryptedArtifactPath: join(dir, "snapshot.tar.gz.enc"),
    outputPath: output,
    vault,
  });
  const info = await stat(output);
  console.log(`[decrypt] 明文 → ${output}（${formatBytes(info.size)}）`);
  console.log("[decrypt] 这一步闭源版做不到：私钥不在客户端。");
}

async function runManifest(argv: string[]): Promise<void> {
  requireGate();
  const workspaceArg = argv[argv.indexOf("--workspace") + 1];
  const workspacePath = workspaceArg ?? process.cwd();
  const { manifest } = await scanRepoSnapshot(workspacePath);
  const hash = computeManifestHash(manifest);
  console.log(
    JSON.stringify(
      {
        workspaceKey: manifest.workspaceKey,
        workspaceKeyHash: workspaceKeyHash(manifest.workspaceKey),
        manifestHash: hash,
        source: manifest.source,
        stats: manifest.stats,
        gitInternal: manifest.files.filter((file) => file.path.split("/").includes(".git")).length,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "capture":
      await runCapture(rest);
      return;
    case "serve":
      await runServe(rest);
      return;
    case "decrypt":
      await runDecrypt(rest);
      return;
    case "manifest":
      await runManifest(rest);
      return;
    default:
      console.error(
        `用法：\n` +
          `  capture [--workspace <path>] [--port <n>]   扫描并上传到 127.0.0.1\n` +
          `  serve [--port <n>]                         本地接收端\n` +
          `  decrypt --dir <groupId 目录>               用本地私钥解密\n` +
          `  manifest [--workspace <path>]              只看清单，不传出\n` +
          `\n启用：${PARODY_FLAG} 或 ${PARODY_ENV_KEY}=1（设置界面里没有这个开关，故意的）`,
      );
      process.exit(2);
  }
}

await main();
