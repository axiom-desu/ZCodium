/**
 * extension-host 契约入口：扩展清单、能力表、授权、槽位贡献、循环回环帧与 SDK 类型。
 * 运行时实现分别在 `services/extensions`（授权/网关/投影）与 Desktop Main（进程生命周期）。
 */
export * from "./capabilities.js";
export * from "./contributions.js";
export * from "./grants.js";
export * from "./manifest.js";
export * from "./protocol.js";
