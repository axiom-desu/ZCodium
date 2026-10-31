import { expect, it, vi } from "vitest";
import { createMobileProjectDirectoryService } from "../src/mobile-project-directory/service.js";

it("late readonly results cannot publish after attachment/source epoch invalidation", async () => {
  let current = true;
  let resolve!: (rows: never[]) => void;
  const readProjects = vi.fn(
    () =>
      new Promise<never[]>((done) => {
        resolve = done;
      }),
  );
  const assertCurrent = () => {
    if (!current) throw new Error("stale epoch");
  };
  const service = createMobileProjectDirectoryService({
    assertCurrent,
    owners: () => [
      {
        hostId: "local",
        projects: { readProjects } as never,
        agent: {} as never,
        tasks: {} as never,
        target: () => undefined,
        assertCurrent,
      },
    ],
  });
  const pending = service.readProjects();
  current = false;
  resolve([]);
  await expect(pending).rejects.toThrow("stale epoch");
  expect(readProjects).toHaveBeenCalledTimes(1);
});
