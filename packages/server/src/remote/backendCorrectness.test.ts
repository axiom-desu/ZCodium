import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createCloseEventController, resolveRemoteExitCode } from "./closeEvent.js";
import { createKeyboardInteractiveResponder, normalizeSSHConnectError } from "./sshAuth.js";
import { createWslExecError } from "./wsl-detect.js";
import { normalizeRemoteConnectionError, publicZCodeErrorCodeSchema } from "@zcode/shared";
import { assertSupportedRemoteEnvironment } from "./remotePlatformSupport.js";

describe("远端真实退出状态", () => {
  it.each([0, 1, 137, 255])("数字码 %s 优先于 signal", (code) => {
    expect(resolveRemoteExitCode(code, "SIGTERM")).toBe(code);
  });

  it("缺失状态不能当成功，未知信号也失败", () => {
    expect(resolveRemoteExitCode(null, undefined)).toBe(255);
    expect(resolveRemoteExitCode(undefined, "UNKNOWN")).toBe(255);
  });

  it.skipIf(process.platform === "win32")("真实隔离子进程 SIGKILL 返回非零", async () => {
    const child = spawn(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    const [code, signal] = await once(child, "close");
    expect(code).toBeNull();
    expect(signal).toBe("SIGKILL");
    expect(resolveRemoteExitCode(code, signal)).toBe(128 + constants.signals.SIGKILL);
  });

  it("close 在订阅前完成时仍保留首次退出状态", async () => {
    const close = createCloseEventController();
    close.fire(137);
    const listener = vi.fn();
    close.event(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(137);
  });
});

describe("SSH 提示证据与超时阶段", () => {
  it("重复多轮多个 Password 不是二次验证", () => {
    const evidence = vi.fn();
    const finish = vi.fn();
    const respond = createKeyboardInteractiveResponder("fixture-password", evidence);
    for (let round = 0; round < 3; round++) {
      respond(
        "login",
        "",
        "",
        [
          { prompt: "Password:", echo: false },
          { prompt: "Password again:", echo: false },
        ],
        finish,
      );
    }
    expect(evidence).not.toHaveBeenCalled();
    expect(finish).toHaveBeenLastCalledWith(["fixture-password", "fixture-password"]);
  });

  it.each(["verification code:", "OTP", "two-factor", "动态口令", "动态密码", "MFA"])(
    "按文字识别 %s，不改变密码回答",
    (prompt) => {
      const evidence = vi.fn();
      const finish = vi.fn();
      createKeyboardInteractiveResponder("fixture-password", evidence)(
        "",
        "",
        "",
        [{ prompt, echo: false }],
        finish,
      );
      expect(evidence).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith(["fixture-password"]);
    },
  );

  it.each(["name", "instructions"])("识别 %s 中的明确提示", (field) => {
    const evidence = vi.fn();
    createKeyboardInteractiveResponder("fixture-password", evidence)(
      field === "name" ? "OTP" : "",
      field === "instructions" ? "verification code:" : "",
      "",
      [{ prompt: "Password:", echo: false }],
      () => {},
    );
    expect(evidence).toHaveBeenCalledOnce();
  });

  it("无密码或空问题仍返回空答案", () => {
    const finish = vi.fn();
    createKeyboardInteractiveResponder()("", "", "", [{ prompt: "OTP", echo: false }], finish);
    expect(finish).toHaveBeenLastCalledWith([]);
    createKeyboardInteractiveResponder("fixture-password")("", "", "", [], finish);
    expect(finish).toHaveBeenLastCalledWith([]);
  });

  it("明确额外验证才改变认证诊断，普通密码失败仍可纠正", () => {
    const cause = Object.assign(new Error("fixture auth failure"), {
      level: "client-authentication",
    });
    const normal = normalizeSSHConnectError(cause);
    expect(normal.message).toContain("检查用户名、密码或私钥");
    expect(
      normalizeSSHConnectError(cause, { additionalVerificationPrompted: true }).message,
    ).toContain("额外验证");
  });

  it("按连接阶段区分握手和 keepalive，不依赖英文错误文本", () => {
    const cause = Object.assign(new Error("fixture timeout"), { level: "client-timeout" });
    expect(normalizeSSHConnectError(cause).message).toContain("握手超时");
    const established = normalizeSSHConnectError(cause, { established: true });
    expect(established.message).toContain("心跳");
    expect(established.message).toContain("60 秒");
    expect(established.message).not.toContain("握手");
    expect(established.cause).toBe(cause);
  });

  it("额外验证公开码保留 cause 且不退化为可补密码认证失败", () => {
    const cause = Object.assign(new Error("fixture auth failure"), {
      level: "client-authentication",
    });
    const error = normalizeSSHConnectError(cause, { additionalVerificationPrompted: true });
    expect(error).toMatchObject({
      code: "remote-authentication-unsupported",
      retryable: false,
      cause,
    });
    expect(publicZCodeErrorCodeSchema.parse("remote-authentication-unsupported")).toBe(
      "remote-authentication-unsupported",
    );
    expect(normalizeRemoteConnectionError(error, "preflight")).toMatchObject({
      code: "remote-authentication-unsupported",
      retryable: false,
    });
    expect(normalizeRemoteConnectionError(normalizeSSHConnectError(cause))).toMatchObject({
      code: "remote-authentication-failed",
    });
  });

  it("Windows 平台拒绝使用公开 typed error 而非 preflight/download 兜底", () => {
    let error: unknown;
    try {
      assertSupportedRemoteEnvironment({ platform: "win32", arch: "x64" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "remote-platform-unsupported", retryable: false });
    expect(publicZCodeErrorCodeSchema.parse("remote-platform-unsupported")).toBe(
      "remote-platform-unsupported",
    );
    expect(normalizeRemoteConnectionError(error, "download")).toMatchObject({
      code: "remote-platform-unsupported",
      retryable: false,
    });
    expect(() =>
      assertSupportedRemoteEnvironment({ platform: "linux", arch: "arm64" }),
    ).not.toThrow();
  });
});

describe("WSL 失败诊断", () => {
  it("stderr 为空时解码 UTF-16LE stdout，带退出码和 cause", () => {
    const cause = Object.assign(new Error("Command failed"), { code: 42 });
    const error = createWslExecError(
      cause,
      Buffer.from("找不到发行版\r\n", "utf16le"),
      Buffer.alloc(0),
    );
    expect(error.message).toBe("找不到发行版（退出码 42）");
    expect(error).toMatchObject({ cause, exitCode: 42 });
  });

  it("stderr 优先；非数字启动码不伪造成退出码", () => {
    const cause = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    const error = createWslExecError(cause, Buffer.from("noise"), Buffer.from("stderr reason\r\n"));
    expect(error.message).toBe("stderr reason");
    expect(error).not.toHaveProperty("exitCode");
  });
});
