import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** 无命中补扫：绕过尚未过期的文件索引。 */
  refresh?: boolean;
}

export type DesignSourceWriteReason =
  | "changed"
  | "invalid_path"
  | "not_html"
  | "too_large"
  | "invalid_utf8"
  /**
   * B7：rootPath 不是本 Host 当前批准的项目/任务根（含无 authority 装配、软链接别名、
   * 已移除 root、远端 Host 路径）。设计端口 fail closed；其它 IFileService 方法不受影响。
   */
  | "unauthorized_root"
  /** 落盘 IO 失败（EACCES/ENOSPC/EIO/fsync 等）：不得报告成功，也不假装是路径问题。 */
  | "io_failed";

export interface IFileService {
  /** Host 匹配并返回有界候选，避免 Renderer 下载完整文件索引。 */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * 按偏移读取文件的一段原始字节，供大二进制文件（如 PDF）按需分段加载。
   * 返回值必须保持顶层 Uint8Array：RPC 序列化只对顶层二进制走原始字节通道，
   * 嵌套在对象字段里会退化成 JSON+base64。EOF 时返回短数组。
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * workspace 文件索引的列式打包长度（字符数）。与 listWorkspaceFilesRange 配对，
   * 调用方按长度分块拉取（见 fetchWorkspaceFileEntriesPacked）。
   * 返回 number：RPC Int 快速路径。
   */
  listWorkspaceFilesLength(params: { rootPath: string }): Promise<number>;
  /**
   * 分块返回列式打包字符串（workspaceFileEntriesCodec 格式，[offset, offset+length)）。
   * 必须是裸 string 顶层返回：RPC String 快速路径（长度前缀+原始字节）；Object 会
   * JSON 转义大字符串（实测 6-9s 主线程长任务）。单块不超过 ~4MB：大消息在
   * renderer 接收端的分帧重组是秒级长任务（实测 4.6-6.3s），分块 + 块间让出后
   * 主线程每次只处理一小块（~50ms），输入永不冻结。
   * Host 侧有 60s TTL + .zcodiumignore 指纹签名的整包缓存，分块只是切片。
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
  }): Promise<string>;
  /**
   * workspace 搜索忽略规则（.zcodiumignore）的读写，供设置页编辑使用。
   * source: "file" 已存在文件内容；"template" 尚未创建时的初始内容预览（保存时才落盘）。
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
   * "sync-gitignore" 只重写 gitignore 同步区（保留默认段与自定义区）；
   * "reset-defaults" 只重置默认排除段（保留 gitignore 区与自定义区）。
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
  /**
   * 内置浏览器设计工具读源码：rootPath 必须是 Host 批准根（项目/任务目录，每次调用重新授权），
   * 只接受 root 内、解析软链接后仍在 root 内的 .html/.htm 文件，整份读出并严格按 UTF-8
   * 解码（保留 BOM），上限 4 MB；无批准/未装配 authority 时抛 design_source_unauthorized_root。
   */
  readDesignSourceFile(params: { rootPath: string; path: string }): Promise<{ content: string }>;
  /**
   * 设计工具写源码：rootPath 同样先经 Host 批准根授权（页面不能选择 root/path，也不能用
   * 软链接别名自我授权），同一 root 内路径校验后，只有当前内容仍等于 expectedContent 才原地写。
   * 内容不是合法 UTF-8 或超限时返回 written=false；路径在 realpath 之后被换成软链接/祖先目录
   * 或硬链接到 root 外时拒绝（invalid_path），真实落盘失败返回 io_failed；跨进程不合作写入者
   * 只能靠内容 CAS 发现。
   */
  writeDesignSourceFile(params: {
    rootPath: string;
    path: string;
    expectedContent: string;
    content: string;
  }): Promise<{ written: boolean; reason?: DesignSourceWriteReason }>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
