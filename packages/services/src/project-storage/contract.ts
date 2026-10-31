/** 公开契约再导出；实现按 domain/app/adapters 分层，外部模块只依赖此入口。 */
export * from "#src/project-storage/domain/contract.js";
export type { ProjectStorageContract } from "#src/project-storage/app/storageContract.js";
