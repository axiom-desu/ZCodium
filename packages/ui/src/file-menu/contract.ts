import type { FileStat } from "@zcode/shared";

/** 文件所属 Host 的读取端口。路径保持该 Host 的语义，不转换成本机路径。 */
export interface FileCopySource {
  stat(params: { path: string }): Promise<Pick<FileStat, "type" | "size" | "mtimeMs">>;
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
}

/**
 * 文件菜单打开方式的候选。
 *
 * A3-lite 直接用 `EditorInfo`（`{ id, name, iconDataUrl }`）满足该形状；
 * 以后若引入系统关联应用，只扩展 `isDefault`，公开组件 props 保持泛型兼容。
 */
export interface FileApplicationChoice {
  id: string;
  name: string;
  iconDataUrl?: string;
  isDefault?: boolean;
}
