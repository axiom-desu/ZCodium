import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  consumeTopLevelCli,
  executeCliPlan,
  getDesktopUserArgv,
  resolveCliPlan,
} from "./cliDispatch.js";

declare const __ZCODE_PRODUCT_FLAVOR__: "production" | "preview";

async function bootstrap(): Promise<void> {
  const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
  const routed = consumeTopLevelCli(getDesktopUserArgv(process.argv.slice(1), defaultApp));
  if (!routed.isCli) {
    await import("./gui.js");
    return;
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const plan = resolveCliPlan({
    argv: routed.argv,
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    isPackaged: !defaultApp,
    productFlavor: __ZCODE_PRODUCT_FLAVOR__,
    resourcesPath,
    bootstrapDir: dirname(fileURLToPath(import.meta.url)),
  });
  await executeCliPlan(plan, process.platform);
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `Desktop CLI bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
