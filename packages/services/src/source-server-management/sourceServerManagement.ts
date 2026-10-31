import type { Event } from "@zcode/rpc";
import type {
  RemoteTarget,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementSnapshot,
  SourceServerManagementSnapshotRequest,
  SourceServerManagementStateDelta,
  SourceServerOperationLog,
  SourceServerUpdateRequest,
  SourceServerUpdateTarget,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** profile 更新只接受已脱敏的 transport target；口令/私钥内容走 credential port。 */
/** 新建 profile 只接受已脱敏 transport target；口令/私钥内容由 directory 的 credential port 保存。 */
export interface CreateConnectionProfileInput {
  target: Exclude<RemoteTarget, { kind: "server" }>;
  profileDisplayName?: string;
  sourceDisplayName?: string;
}

export interface UpdateConnectionProfileInput {
  profileId: string;
  profileDisplayName: string;
  sourceDisplayName?: string;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  sshAuthMethod?: "password" | "privateKey";
}

/**
 * Source Server 管理服务（Host 公开端口，UI 向导/设置页消费）。
 *
 * 所有方法只操作既有 window registry / Host attachment；不创建第二个 Remote Host、
 * 不启动 Agent，也不在 Main 保存业务队列或快照。
 */
export interface ISourceServerManagementService {
  readonly onDidChangeState: Event<SourceServerManagementStateDelta>;
  readonly onDidChangeDirectory: Event<SourceServerManagementDirectoryDelta>;
  /** 连接/更新过程日志；历史由 Host 内存 owner 保留。 */
  readonly onDidAppendOperationLog: Event<SourceServerOperationLog>;
  getSnapshot(
    options?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot>;
  getRecentOperationLogs(profileId: string): Promise<SourceServerOperationLog[]>;
  /** 通过已保存 profile 建立/复用连接。 */
  connectProfile(
    profileId: string,
    options?: {
      retainedOnly?: boolean;
      confirmSourceServerInstall?: boolean;
      /** 向导 preview 时的目标；await 期间目标变化必须拒绝，不能对同 id 新地址执行旧确认。 */
      expectedTarget?: SourceServerUpdateTarget;
    },
  ): Promise<SourceServerManagementSnapshot>;
  /** 按 Source 的首选 profile 建立连接；无 profile 时 typed 拒绝。 */
  connectSource(
    sourceServerId: string,
    options?: {
      confirmSourceServerInstall?: boolean;
      expectedTarget?: SourceServerUpdateTarget;
    },
  ): Promise<SourceServerManagementSnapshot>;
  /** 断开在线 owner；不删除 profile/历史。 */
  disconnect(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /** 需要显式安装/升级时由向导确认后重试。 */
  confirmIdentityChange(profileId: string): Promise<SourceServerManagementSnapshot>;
  /** expectedTarget 在 await 前后各校验一次；force 只影响 running-task busy guard。 */
  updateSource(input: SourceServerUpdateRequest): Promise<SourceServerManagementSnapshot>;
  renameSource(
    sourceServerId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot>;
  renameProfile(profileId: string, displayName: string): Promise<SourceServerManagementSnapshot>;
  /** 按 target 复用/新建 profile；已存在时原地返回，不重复建目录记录。 */
  createProfile(input: CreateConnectionProfileInput): Promise<SourceServerManagementSnapshot>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<SourceServerManagementSnapshot>;
  setPreferredProfile(
    sourceServerId: string,
    profileId: string,
  ): Promise<SourceServerManagementSnapshot>;
  removeProfile(profileId: string): Promise<SourceServerManagementSnapshot>;
  removeSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
}

export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
