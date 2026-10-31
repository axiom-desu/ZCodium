import { describe, expect, it } from "vitest";
import {
  TID_SERVER_NAME_INPUT,
  TID_SERVER_TOKEN_INPUT,
  TID_SERVER_URL_INPUT,
  TID_SERVER_WORKSPACE_PATH_INPUT,
} from "@zcode/shared";
import { buildRemoteTarget } from "@/lib/remoteConnectionWizard.js";

const intl = {
  formatMessage: (descriptor: { id: string }) => descriptor.id,
};

const base = {
  kind: "server" as const,
  host: "",
  port: "22",
  username: "",
  sshAuthMethod: "password" as const,
  password: "",
  privateKeyPath: "",
  privateKeyPassphrase: "",
  wslDistro: "",
  dockerContainer: "",
};

describe("server 直连向导目标", () => {
  it("URL/名称/token/默认目录按 trim 后进入 target", () => {
    const { target, errorMessage } = buildRemoteTarget(intl, {
      ...base,
      serverUrl: "  https://studio.example:3030  ",
      serverName: "  Studio  ",
      serverToken: "  secret-token  ",
      serverWorkspacePath: "  /srv/app  ",
    });
    expect(errorMessage).toBeUndefined();
    expect(target).toEqual({
      kind: "server",
      url: "https://studio.example:3030",
      name: "Studio",
      token: "secret-token",
      workspacePath: "/srv/app",
    });
  });

  it("可选字段为空时不写入 target，也不伪造 token", () => {
    const { target } = buildRemoteTarget(intl, {
      ...base,
      serverUrl: "https://studio.example",
      serverName: "   ",
      serverToken: "   ",
      serverWorkspacePath: "   ",
    });
    expect(target).toEqual({ kind: "server", url: "https://studio.example" });
  });

  it("缺少或非法 URL 返回表单校验错误而不是 unsupported dead end", () => {
    expect(buildRemoteTarget(intl, { ...base, serverUrl: "   " })).toEqual({
      errorMessage: "server.validation.urlRequired",
    });
    expect(buildRemoteTarget(intl, { ...base, serverUrl: "not a url" })).toEqual({
      errorMessage: "server.validation.invalidUrl",
    });
  });

  it("server 表单用独立 testid，避免与 SSH 字段混用", () => {
    expect(
      new Set([
        TID_SERVER_URL_INPUT,
        TID_SERVER_NAME_INPUT,
        TID_SERVER_TOKEN_INPUT,
        TID_SERVER_WORKSPACE_PATH_INPUT,
      ]).size,
    ).toBe(4);
  });
});
