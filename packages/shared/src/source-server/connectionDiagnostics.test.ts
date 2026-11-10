import { describe, expect, it } from "vitest";
import { normalizeRemoteConnectionError } from "./connectionErrors.js";
import { sanitizeRemoteConnectionLog } from "./connectionLog.js";
import { publicZCodeErrorCodeSchema } from "./contract.js";

describe("公开远端失败诊断", () => {
  it("显式领域 unknown 保留 code/retryable/cause，不依赖错误文案", () => {
    const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const error = Object.assign(new Error("合成领域错误"), {
      remoteConnectionErrorKind: "domain",
      code: "remote-connection-unknown",
      retryable: false,
      cause,
      errors: [Object.assign(new Error("other detail"), { code: "ECONNREFUSED" })],
      error: Object.assign(new Error("other detail"), { code: "ENOSPC" }),
    });
    expect(normalizeRemoteConnectionError(error, "preflight")).toEqual({
      code: "remote-connection-unknown",
      message: "合成领域错误",
      retryable: false,
    });
    expect(error.cause).toBe(cause);
  });

  it.each([
    [Object.assign(new Error("detail"), { code: "EACCES" }), "remote-permission-denied"],
    [new Error("permission denied"), "remote-permission-denied"],
    [Object.assign(new Error("detail"), { code: "ECONNREFUSED" }), "remote-host-unreachable"],
    [
      Object.assign(new Error("detail"), { code: "remote-platform-unsupported" }),
      "remote-platform-unsupported",
    ],
  ])("普通 unknown wrapper 仍从 cause %s 提取 %s", (cause, code) => {
    const error = Object.assign(new Error("普通包装"), {
      code: "remote-connection-unknown",
      cause,
    });
    expect(normalizeRemoteConnectionError(error, "preflight")).toMatchObject({ code });
  });

  it.each([undefined, "not-a-public-code"])("领域标记没有有效公开码 %s 不能阻止下钻", (code) => {
    const error = Object.assign(new Error("普通包装"), {
      remoteConnectionErrorKind: "domain",
      code,
      cause: Object.assign(new Error("detail"), { code: "EACCES" }),
    });
    expect(normalizeRemoteConnectionError(error)).toMatchObject({
      code: "remote-permission-denied",
    });
  });

  it.each(["remote-authentication-unsupported", "remote-platform-unsupported"])(
    "%s 从 cause 穿过阶段包装，不能诱导重试或补密码",
    (code) => {
      publicZCodeErrorCodeSchema.parse(code);
      expect(
        normalizeRemoteConnectionError(
          Object.assign(new Error("wrapper"), {
            cause: Object.assign(new Error("private detail"), { code, retryable: true }),
          }),
          "preflight",
        ),
      ).toMatchObject({ code, retryable: false });
    },
  );

  it.each([
    ["unix:///home/private-fixture/docker.sock", "Is the docker daemon running?"],
    ["npipe:////./pipe/private-fixture", "Is the docker daemon running?"],
    ["tcp://private-fixture.example:2375", "connection refused"],
  ])("Docker daemon URL %s 不泄漏且保留正文", (url, reason) => {
    const output = sanitizeRemoteConnectionLog(`Cannot connect at ${url} ${reason}`);
    expect(output).toBe(`Cannot connect at [redacted-url] ${reason}`);
    expect(output).not.toContain("private-fixture");
    expect(sanitizeRemoteConnectionLog(output)).toBe(output);
  });

  it.each(["no such file or directory", "connection refused", "permission denied"])(
    "裸 socket 路径保留明确 connect errno：%s",
    (reason) => {
      const raw = `Get "http://private-fixture.local/v1": dial unix /home/private-fixture/My Docker/docker.sock: connect: ${reason}`;
      const output = sanitizeRemoteConnectionLog(raw);
      expect(output).toContain("[redacted-url]");
      expect(output).toContain(`[redacted-path]: connect: ${reason}`);
      expect(output).not.toContain("private-fixture");
      expect(output).not.toContain("My Docker");
      expect(sanitizeRemoteConnectionLog(output)).toBe(output);
    },
  );

  it("不把任意路径尾部误认成诊断；已有秘密/TOFU 分类不回归", () => {
    expect(
      sanitizeRemoteConnectionLog("dial unix /home/private-fixture/secret: connect: private-tail"),
    ).toBe("dial unix [redacted-path]");
    expect(
      normalizeRemoteConnectionError(
        Object.assign(new Error("Host denied"), {
          code: "remote-host-key-changed",
        }),
      ),
    ).toMatchObject({ code: "remote-host-key-changed" });
    expect(sanitizeRemoteConnectionLog("device password=dev", ["dev"])).toBe(
      "device password=[redacted]",
    );
  });
});
