import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { ChannelServer, Emitter, VSBuffer } from "@zcode/rpc";
import { encodeWebRemoteControlRpcFrames, WebRemoteControlRpcAssembler } from "@zcode/shared";
import { IMobileProjectDirectoryService } from "../src/mobile-project-directory/contract.js";
import { LanRemoteControlEndpoint } from "../../desktop/src/main/webRemoteControl/lanEndpoint.js";

/**
 * 旧 peer（Initialize 未宣告 mobileProjectDirectory）回归：手机首页必须保持原样，
 * 不能为缺失的 channel 建代理，也不能出现永远不完成的目录调用。
 */
it("old peer without the directory capability keeps the legacy mobile home", async () => {
  const temp = await mkdtemp(join(tmpdir(), "s9-directory-cap-absent-"));
  await mkdir(join(temp, "mobile"), { recursive: true });
  const previousMobile = process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
  process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = join(temp, "mobile");
  const bundle = await build({
    entryPoints: [resolve("packages/web/src/mobile/main.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  await writeFile(join(temp, "mobile/mobile.js"), bundle.outputFiles[0]!.contents);
  await writeFile(
    join(temp, "mobile/mobile.html"),
    (await readFile(resolve("packages/web/mobile.html"), "utf8")).replace(
      "/src/mobile/main.tsx",
      "/mobile.js",
    ),
  );
  const workspace = { workspaceKey: "/fixture", workspacePath: "/fixture", kind: "local" as const };
  const payloads: string[] = [];
  const directoryCalls = vi.fn();
  let server: ChannelServer | undefined;
  let incoming: Emitter<VSBuffer> | undefined;
  let assembler: WebRemoteControlRpcAssembler | undefined;
  let streamId = "";
  let seq = 0;
  const endpoint = new LanRemoteControlEndpoint({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deviceMid: "s9-cap-absent",
    deviceName: "fixture",
    appVersion: "test",
    handleMobilePayload(_sid, payload) {
      payloads.push(payload.zcode_type);
      if (payload.zcode_type === "bootstrap-request")
        device.sendPayload({
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: "fixture",
            desktopAppVersion: "test",
            workspaces: [workspace],
            tasks: [],
          },
        });
      if (payload.zcode_type === "workspace-bridge-open") {
        server?.dispose();
        incoming?.dispose();
        incoming = new Emitter<VSBuffer>();
        streamId = payload.bridgeSessionId;
        seq = 0;
        assembler = new WebRemoteControlRpcAssembler({ streamId });
        // 旧 peer：Initialize 不宣告目录 capability；channel 存在但绝不能被调用。
        server = new ChannelServer(
          {
            onMessage: incoming.event,
            send: (buffer) => {
              const frames = encodeWebRemoteControlRpcFrames(
                { __zcodeBytes: Buffer.from(buffer.buffer).toString("base64") },
                { streamId, seq: ++seq },
              );
              for (const frame of frames) device.sendPayload({ zcode_type: "rpc-frame", frame });
            },
          },
          "host",
          1000,
          true,
        );
        server.registerChannel(IMobileProjectDirectoryService.channelName, {
          call: (_ctx: string, command: string) => {
            directoryCalls(command);
            return Promise.resolve([]);
          },
          listen: () => ({ dispose() {} }),
        });
        device.sendPayload({
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: streamId,
          bridgeGeneration: payload.bridgeGeneration,
          bridge: { ...workspace, bridgeSessionId: streamId, entryKind: "home" },
        });
        server.ready();
      }
      if (payload.zcode_type === "rpc-frame" && payload.frame.kind === "message") {
        for (const event of assembler?.push(payload.frame) ?? [])
          if (event.kind === "message") {
            incoming?.fire(
              VSBuffer.wrap(
                Buffer.from((event.message as { __zcodeBytes: string }).__zcodeBytes, "base64"),
              ),
            );
            device.sendPayload({
              zcode_type: "rpc-frame",
              frame: { streamId, seq: event.seq, kind: "ack", ackSeq: event.seq },
            });
          }
      }
    },
  });
  const passHash = createHash("sha256").update(randomBytes(32)).digest("base64");
  const device = endpoint.registerDevice(
    { mode: "register", passHash },
    {
      onStateChange() {},
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      onInvalidPersistedAuth() {},
      onMobileDisconnected() {},
    },
  );
  let context;
  try {
    const info = await endpoint.start();
    context = await chromium.launchPersistentContext(join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
      viewport: { width: 390, height: 844 },
      args: ["--no-proxy-server"],
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${info.port}/?sid=${encodeURIComponent(device.deviceSid)}&hash=${encodeURIComponent(passHash)}&mid=s9&name=fixture`,
    );
    await page.getByText("已连接到当前桌面窗口").waitFor();
    await page.getByText("1 个工作区 · 0 个任务").waitFor();
    await page.getByRole("button", { name: "整理任务：按时间线" }).waitFor();
    // 旧首页：没有目录区块、没有 desktop 提示，也没有任何目录 RPC。
    await vi.waitFor(() => expect(payloads).toContain("workspace-bridge-open"));
    expect(await page.getByRole("region", { name: "项目目录 / Project directory" }).count()).toBe(
      0,
    );
    expect(await page.getByText("请在桌面端打开 / Open on desktop").count()).toBe(0);
    expect(directoryCalls).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await endpoint.stop();
    server?.dispose();
    incoming?.dispose();
    if (previousMobile === undefined) delete process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
    else process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = previousMobile;
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
