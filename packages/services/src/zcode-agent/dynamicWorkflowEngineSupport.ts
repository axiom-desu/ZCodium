import type { DynamicWorkflowEngineSupport } from "@zcode/shared";
import {
  resolveZCodeAgentRuntimeKind,
  type ZCodeAgentRuntimeKind,
} from "./zcodeAgentProcessManager.js";

/**
 * 执行端是否真的带 DWF 引擎（docs/dynamic-workflow/launch.md）。
 *
 * Rust CLI 只有协议字段，没有十个 workflow 工具的实现：`dynamicWorkflowEnabled` /
 * `dynamicWorkflowMode` 会被解析后丢弃。此时把「用户开启」当成已生效，目录会出现
 * `/workflow`、技能与自动化页的工作流 tab，模型却没有任何工具——这就是假装支持。
 *
 * 判定来自 runtime 选择 owner 的公开解析结果（`resolveZCodeAgentRuntimeKind`），不是本模块
 * 再复制一份 env 判断：自定义命令、TS、Rust 的口径必须与真正拉起进程的那一侧一致。
 * 只保留 env 入参是为了让单元测试和嵌入方可以显式注入选择结果。
 */
export function resolveDynamicWorkflowEngineSupport(
  source: Record<string, string | undefined> | ZCodeAgentRuntimeKind = process.env,
): DynamicWorkflowEngineSupport {
  const kind = typeof source === "string" ? source : resolveZCodeAgentRuntimeKindFromEnv(source);
  return kind === "zcode-cli-rust" ? "unsupported" : "supported";
}

function resolveZCodeAgentRuntimeKindFromEnv(
  env: Record<string, string | undefined>,
): ZCodeAgentRuntimeKind {
  try {
    return resolveZCodeAgentRuntimeKind(env);
  } catch {
    // 未知的 runtime 选择会被进程启动侧拒绝；能力读取不能反过来把功能打开。
    return "zcode-cli-rust";
  }
}
