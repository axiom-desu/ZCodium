/**
 * Computer Use 运行时适配器：把 `@trycua/cua-driver` 接到 ZCode 的
 * `ComputerUseRuntime` 端口上。
 *
 * 决策与背景见 `.agents/specs/computer-use-runtime.md`。
 *
 * 三条约束：
 *  1. 原生执行只有一个所有者——cua-driver。本文件不缓存窗口、坐标、剪贴板，
 *     也不实现任何平台逻辑。
 *  2. client 通过依赖注入传入（同进程 SDK、daemon connect、MCP proxy 或测试假件）。
 *     没有 client 时**保持 fail-closed**，不伪造成功。
 *  3. 结果只做投影，不改语义：`ToolResult` → host 认识的 `CallToolResult`，
 *     原始字段经 `_meta` 透传，避免在适配层猜测 driver 的语义。
 */

import { COMPAT_INPUT_TOOLS } from "./compatible/executor.js";
import { createSurfaceLayer, ZCODE_SURFACE_TOOLS } from "./surface.js";

export const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

/** 适配器读取的 client 端口。cua-driver 的 TS SDK 与 MCP proxy 都满足它。 */
export function assertCuaDriverClient(client) {
  if (!client || typeof client !== "object" || typeof client.callTool !== "function") {
    return "Computer Use driver client is missing a callTool() method";
  }
  return undefined;
}

/** fail-closed 运行时：任何调用都返回一条可操作的错误，绝不留假成功。 */
export function createUnavailableRuntime(reason = UNAVAILABLE_TEXT) {
  const unavailable = async () => ({
    content: [{ type: "text", text: reason }],
    isError: true,
    _meta: { cuaUnavailable: true },
  });
  return {
    execute: unavailable,
    async closeSession() {},
    async dispose() {},
  };
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * cua-driver `ToolResult` → MCP `CallToolResult`。
 *
 * `structuredJson` / `rawJson` 本身就是字符串，解析出来不含 bigint（JSON 没有 bigint），
 * 所以这里可以安全地把 driver 的平台扩展字段透传给 host。`action` / `verification`
 * 这两个类型化字段可能带 bigint，故只经 `rawJson` 传递，不在此处再序列化。
 */
export function projectToolResult(result) {
  if (!result || typeof result !== "object") {
    return { content: [], isError: false };
  }
  const content = [];
  if (typeof result.text === "string" && result.text.length > 0) {
    content.push({ type: "text", text: result.text });
  }
  for (const image of Array.isArray(result.images) ? result.images : []) {
    if (image && typeof image.dataBase64 === "string" && typeof image.mimeType === "string") {
      content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
    }
  }

  const projected = { content, isError: result.isError === true };

  const structured = parseJson(result.structuredJson);
  if (structured !== undefined) projected.structuredContent = structured;

  const meta = {};
  if (typeof result.errorCode === "string" && result.errorCode.length > 0) {
    meta.errorCode = result.errorCode;
  }
  if (result.degraded === true) meta.degraded = true;
  const raw = parseJson(result.rawJson);
  if (raw !== undefined) meta.driverResult = raw;
  if (Object.keys(meta).length > 0) projected._meta = meta;

  return projected;
}

/** driver 抛出的拒绝（`DriverError.Tool`）→ MCP 错误结果。 */
export function projectDriverError(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    (typeof error?.errorCode === "string" && error.errorCode) ||
    (typeof error?.code === "string" && error.code) ||
    undefined;
  const structuredContent = { tool: toolName, ...(code ? { code } : {}) };
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
    _meta: { ...(code ? { errorCode: code } : {}), driverError: true },
  };
}

/**
 * 构造真实运行时。
 *
 * @param {object} client 满足 `callTool(name, argumentsJson, opts?)` 的 driver client
 */
export function createCuaDriverRuntime(client, options = {}) {
  const missing = assertCuaDriverClient(client);
  if (missing) return createUnavailableRuntime(missing);

  // 兼容层（老 GNOME）只接管输入类工具；观察/语义始终走 cua-driver（见 §8.1 路由）。
  const compat = options.compat;

  // 胶水：ZCode 模型面（14 工具）走 surface 映射层；原生工具名直接透传。
  const callDriver = (toolName, args, signal) => {
    const argsJson = JSON.stringify(args ?? {});
    return signal
      ? client.callTool(toolName, argsJson, { signal })
      : client.callTool(toolName, argsJson);
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat,
    compatApplies: compat?.applies === true,
    projectDriverResult: projectToolResult,
    projectDriverError: projectDriverError,
  });

  return {
    async execute(input) {
      const toolName = typeof input?.toolName === "string" ? input.toolName : "";
      if (!toolName) {
        return projectDriverError("<missing>", new Error("Computer Use tool name is missing"));
      }
      if (ZCODE_SURFACE_TOOLS.includes(toolName)) {
        return surface.execute(input);
      }
      if (compat?.applies === true && COMPAT_INPUT_TOOLS.has(toolName)) {
        return compat.execute(input);
      }
      const argsJson = JSON.stringify(input.arguments ?? {});
      try {
        // cua-driver SDK 的第三个参数必须包含 signal；传空对象会在读取
        // `signal.aborted` 时报错，因此无 signal 时不传第三个参数。
        const result = input.signal
          ? await client.callTool(toolName, argsJson, { signal: input.signal })
          : await client.callTool(toolName, argsJson);
        return projectToolResult(result);
      } catch (error) {
        return projectDriverError(toolName, error);
      }
    },
    async closeSession() {
      // cua-driver 的会话是多调用公共标签，由每次工具参数携带；
      // SDK 侧的隐式会话由 driver 自行回收，这里不需要额外开/关。
      if (typeof client.endSession !== "function") return;
      try {
        await client.endSession();
      } catch {
        // 会话收尾失败不应阻断上层清理。
      }
    },
    async dispose() {
      if (typeof compat?.dispose === "function") {
        try {
          await compat.dispose();
        } catch {
          // 兼容层收尾失败不应阻断 driver 回收。
        }
      }
      if (typeof client.dispose === "function") {
        await client.dispose();
        return;
      }
      // cua-driver SDK 用 shutdown() 而非 dispose()。
      if (typeof client.shutdown === "function") await client.shutdown();
    },
  };
}

/**
 * 唯一入口：与 `ComputerUseRuntime` 端口同签名。
 *
 * `options.client` 缺失时返回 fail-closed 运行时——这与本次改造前
 * `packages/zcode-cua/index.js` 的行为一致，保证没有 driver 的构建不受影响。
 */
export function createComputerUseRuntime(options = {}) {
  if (options.client) return createCuaDriverRuntime(options.client, options);
  return createUnavailableRuntime(
    options.unavailableReason ??
      "Computer Use is unavailable: no cua-driver client was provided for this build.",
  );
}
