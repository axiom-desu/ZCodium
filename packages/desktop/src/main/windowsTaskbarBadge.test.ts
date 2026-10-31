import { beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({
  representations: [] as Array<{
    scaleFactor: number;
    width: number;
    height: number;
    buffer: Buffer;
  }>,
}));

vi.mock("electron", () => ({
  nativeImage: {
    createEmpty: () => ({
      addRepresentation: (representation: (typeof captures.representations)[number]) =>
        captures.representations.push(representation),
    }),
  },
}));

describe("createTaskbarNumberImage", () => {
  beforeEach(() => {
    captures.representations.length = 0;
  });

  it("数量不能只存在于 description，1/2/9+ 的两档像素必须不同", async () => {
    const { createTaskbarNumberImage } = await import("./windowsTaskbarBadge.js");
    const { renderTaskbarNumberPixels } = await import("./taskbarNumberPixels.js");
    for (const label of ["1", "2", "9+"]) createTaskbarNumberImage(label);
    expect(captures.representations).toHaveLength(6);
    expect(
      captures.representations
        .slice(0, 2)
        .map(({ scaleFactor, width, height }) => ({ scaleFactor, width, height })),
    ).toEqual([
      { scaleFactor: 1, width: 16, height: 16 },
      { scaleFactor: 2, width: 32, height: 32 },
    ]);
    for (const index of [0, 1]) {
      expect(captures.representations[index]!.buffer).not.toEqual(
        captures.representations[index + 2]!.buffer,
      );
      expect(captures.representations[index + 2]!.buffer).not.toEqual(
        captures.representations[index + 4]!.buffer,
      );
      expect(captures.representations[index]!.buffer).toEqual(
        Buffer.from(renderTaskbarNumberPixels("1", index === 0 ? 1 : 2)),
      );
    }
  });
});
