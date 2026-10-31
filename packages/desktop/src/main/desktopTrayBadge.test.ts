import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const trayInstances: Array<{ images: unknown[] }> = [];
  const representations: Array<{
    scaleFactor: number;
    width: number;
    height: number;
    buffer: Buffer;
  }> = [];
  let baseImageCounter = 0;

  const createBaseBuffer = (size: number) => {
    // 不透明蓝底（预乘 BGRA），模拟托盘底图的 1x / 2x 表示。
    const buffer = Buffer.alloc(size * size * 4);
    for (let offset = 0; offset < buffer.length; offset += 4) {
      buffer[offset] = 200;
      buffer[offset + 1] = 40;
      buffer[offset + 2] = 10;
      buffer[offset + 3] = 255;
    }
    return buffer;
  };
  const baseBuffer16 = createBaseBuffer(16);
  const baseBuffer32 = createBaseBuffer(32);

  const fakeBaseImage = () => ({
    __baseImage: ++baseImageCounter,
    isEmpty: () => false,
    resize: ({ width }: { width: number }) => ({
      toBitmap: () => (width === 16 ? baseBuffer16 : baseBuffer32),
    }),
  });

  return {
    trayInstances,
    representations,
    fakeBaseImage,
    resetBaseImageCounter: () => {
      baseImageCounter = 0;
    },
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
  Tray: class {
    images: unknown[] = [];
    constructor() {
      state.trayInstances.push({ images: this.images });
    }
    setImage(image: unknown) {
      this.images.push(image);
    }
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  nativeImage: {
    createFromPath: () => state.fakeBaseImage(),
    createEmpty: () => ({
      __composed: true,
      addRepresentation: (representation: {
        scaleFactor: number;
        width: number;
        height: number;
        buffer: Buffer;
      }) => state.representations.push(representation),
    }),
  },
}));

function pixelAt(buffer: Buffer, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!];
}

const trayOptions = {
  platform: "win32" as const,
  getLocale: () => "zh-CN" as const,
  showCurrentWindow: () => {},
  executeDesktopCommand: async () => {},
  quitApp: () => {},
  logger: { warn: vi.fn() },
};

describe("desktop tray unread badge", () => {
  beforeEach(() => {
    vi.resetModules();
    state.trayInstances.length = 0;
    state.representations.length = 0;
    state.resetBaseImageCounter();
  });

  async function loadModule() {
    return import("./desktopTray.js");
  }

  it("没有托盘时 no-op 不抛错", async () => {
    const { applyDesktopTrayUnreadBadge } = await loadModule();

    expect(() => applyDesktopTrayUnreadBadge(3)).not.toThrow();
    expect(state.trayInstances).toHaveLength(0);
  });

  it("非 Windows 平台不创建托盘，保持当前平台边界", async () => {
    const { createWindowsDesktopTray } = await loadModule();

    expect(createWindowsDesktopTray({ ...trayOptions, platform: "linux" })).toBeNull();
    expect(state.trayInstances).toHaveLength(0);
  });

  it("计数非零时合成 1x/2x 红点，并按 label 缓存", async () => {
    const mod = await loadModule();
    mod.createWindowsDesktopTray(trayOptions);
    expect(state.trayInstances).toHaveLength(1);

    mod.applyDesktopTrayUnreadBadge(3);
    mod.applyDesktopTrayUnreadBadge(3);

    expect(state.representations).toHaveLength(2);
    expect(
      state.representations.map(({ scaleFactor, width, height }) => ({
        scaleFactor,
        width,
        height,
      })),
    ).toEqual([
      { scaleFactor: 1, width: 16, height: 16 },
      { scaleFactor: 2, width: 32, height: 32 },
    ]);

    const oneX = state.representations[0]!.buffer;
    const twoX = state.representations[1]!.buffer;
    // 纯红芯 + 与底图混合的抗锯齿边缘，不能出现白色数字笔画。
    expect(pixelAt(oneX, 16, 13, 2)).toEqual([53, 57, 229, 255]);
    expect(pixelAt(twoX, 32, 27, 4)).toEqual([53, 57, 229, 255]);
    expect(pixelAt(twoX, 32, 23, 4)).not.toEqual([200, 40, 10, 255]);
    expect(pixelAt(twoX, 32, 23, 4)).not.toEqual([53, 57, 229, 255]);
    // 远离红点的 Logo 像素保持原底图。
    expect(pixelAt(oneX, 16, 8, 8)).toEqual([200, 40, 10, 255]);
    expect(pixelAt(twoX, 32, 16, 16)).toEqual([200, 40, 10, 255]);
  });

  it("计数归零时恢复原始托盘底图而不是保留红点", async () => {
    const mod = await loadModule();
    mod.createWindowsDesktopTray(trayOptions);

    mod.applyDesktopTrayUnreadBadge(3);
    mod.applyDesktopTrayUnreadBadge(0);

    const images = state.trayInstances[0]!.images;
    expect(images).toHaveLength(2);
    expect(images[1]).toMatchObject({ __baseImage: 1 });
  });
});
