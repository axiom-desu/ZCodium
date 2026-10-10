/**
 * 兼容层 helper 的 Node 侧客户端：spawn、JSON-lines 请求/响应、监督与销毁。
 *
 * helper 是 GJS 长驻进程（`compatible/helper/cua-wayland-input.js`），
 * 原因见 `.agents/specs/computer-use-wayland-input.md` §8.3。
 *
 * 本模块只做进程与协议，不含任何平台逻辑；`spawn` 可注入以便用假进程单测。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("./helper/cua-wayland-input.js", import.meta.url),
);

/**
 * @param {object} [options]
 * @param {string} [options.command] 解释器（GNOME 自带 `gjs`）
 * @param {string} [options.helperPath] helper 脚本路径
 * @param {Function} [options.spawn] 注入的 spawn（测试用）
 * @param {number} [options.requestTimeoutMs] 单请求超时
 */
export function createHelperClient({
  command = "gjs",
  helperPath = DEFAULT_HELPER_PATH,
  spawn = nodeSpawn,
  requestTimeoutMs = 10_000,
} = {}) {
  let child = null;
  let buffer = "";
  let nextId = 1;
  let disposed = false;
  let lastStderr = "";
  const pending = new Map();

  function failAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function onLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === "ready") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "helper rejected the request"));
  }

  function ensureStarted() {
    if (disposed) throw new Error("compat helper client is disposed");
    if (child) return;
    child = spawn(command, [helperPath], { stdio: ["pipe", "pipe", "pipe"] });
    buffer = "";
    lastStderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      lastStderr = String(chunk).trim();
    });
    child.on("error", (error) => {
      lastStderr = error.message;
      failAll(error);
      child = null;
    });
    child.on("exit", () => {
      failAll(new Error(lastStderr || "compat helper exited"));
      child = null;
      buffer = "";
    });
  }

  async function request(method, params = {}) {
    ensureStarted();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`compat helper timeout: ${method}`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function dispose() {
    disposed = true;
    const active = child;
    if (!active) return;
    child = null;
    try {
      active.stdin.write(`${JSON.stringify({ id: nextId++, method: "shutdown", params: {} })}\n`);
    } catch {
      // helper 已退出，直接等 exit / kill。
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          active.kill("SIGKILL");
        } catch {
          // 忽略：进程可能已退出。
        }
        resolve();
      }, 1000);
      timer.unref?.();
      active.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    request,
    dispose,
    get running() {
      return child !== null;
    },
  };
}
