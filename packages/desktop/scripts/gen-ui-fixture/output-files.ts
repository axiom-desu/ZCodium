import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getGenUiOutputDirectory } from "@zcode/shared/node";

export async function prepareOutputFiles(root: string) {
  const workspacePath = join(root, "workspace");
  const outputRoot = join(root, "user-data", "visualizations");
  await mkdir(workspacePath);
  const paths: Record<string, string> = {};
  for (const sessionId of ["fixture", "second-task"]) {
    const directory = getGenUiOutputDirectory(outputRoot, {
      workspacePath,
      workspaceIdentity: "ssh:fixture:/workspace",
      sessionId,
    });
    await mkdir(directory, { recursive: true });
    paths[sessionId] = join(directory, "demo.html");
    await copyFile(join(root, "demo.html"), paths[sessionId]!);
  }
  return { workspacePath, outputRoot, paths };
}
