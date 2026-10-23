/** 共享类型。字段名对齐闭源版 state.json / manifest，便于并排 diff。 */

export const PARODY_SCHEMA = "zcode-repo-snapshot-parity/v1" as const;

/** 与工作区路径绑定的稳定标识：规范化绝对路径。 */
export interface WorkspaceKey {
  readonly workspacePath: string;
}

export interface ManifestFile {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface ManifestStats {
  readonly includedFileCount: number;
  readonly includedBytes: number;
}

export interface RepoSnapshotManifest {
  readonly schema: typeof PARODY_SCHEMA;
  readonly workspaceKey: string;
  readonly createdAt: number;
  /** 文件列表来源：git ls-files 或纯文件系统遍历。 */
  readonly source: "git" | "walk";
  readonly files: readonly ManifestFile[];
  readonly stats: ManifestStats;
}

export type CaptureKind = "baseline" | "increment";

export interface SnapshotDelta {
  readonly schema: typeof PARODY_SCHEMA;
  readonly baseManifestHash: string;
  readonly nextManifestHash: string;
  readonly addedOrModified: readonly ManifestFile[];
  readonly deleted: readonly string[];
}

/** 信封。形状与闭源版一致，唯一差别是公钥来自本地。 */
export interface EncryptionEnvelope {
  readonly schema: typeof PARODY_SCHEMA;
  readonly contentAlgorithm: "aes-256-ctr";
  readonly keyWrapAlgorithm: "rsa-oaep-sha256";
  readonly keyId: string;
  readonly nonceEncoding: "ciphertext-prefix-16-byte";
  readonly aadEncoding: "canonical-json-v1";
  readonly aad: {
    readonly schema: typeof PARODY_SCHEMA;
    readonly workspaceKeyHash: string;
    readonly kind: CaptureKind;
    readonly manifestHash: string;
    readonly baseManifestHash?: string;
    readonly compression: "tar.gz";
  };
  /** 用本地 RSA 公钥包住的 AES 密钥，base64。 */
  readonly encryptedDataKey: string;
  readonly plaintextSha256: string;
}

export interface CompressedSizeRecord {
  readonly encryptedSizeBytes: number;
  readonly workspaceSizeBytes: number;
  readonly manifestHash: string;
  readonly recordedAt: number;
}

export interface PendingUploadRecord {
  readonly groupId: string;
  readonly kind: CaptureKind;
  readonly encryptedArtifactPath: string;
  readonly encryptionEnvelopePath: string;
  readonly manifestPath: string;
  readonly baseManifestHash?: string;
  readonly nextManifestHash: string;
  readonly createdAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  readonly failureCountedAt?: number;
}

export interface RepoSnapshotState {
  readonly workspacePath: string;
  readonly workspaceKey: string;
  readonly lastAcceptedManifestHash?: string;
  readonly lastAcceptedManifestPath?: string;
  readonly activeUpload?: PendingUploadRecord;
  readonly latestPendingUpload?: PendingUploadRecord;
  readonly lastCompressedSize?: CompressedSizeRecord;
  readonly failureCount: number;
}
