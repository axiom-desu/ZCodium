import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";

// CI 尚未构建 CLI；统一源码解析也让测试运行时的 UI 动态导入保留路径别名。
const testOptions = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("./tsconfig.observability-tests.json", import.meta.url)),
};

await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/test/local-observability.test.ts",
  testOptions,
);
// 购买 webview 与其测试已随 billing 移除；不能让遗留引用阻断其余本地诊断测试。
await tsImport("../../packages/ui/test/localDiagnostics.test.ts", testOptions);
await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/test/local-measurements.test.ts",
  testOptions,
);
await tsImport("../../apps/zcode-cli/packages/cli/test/direct-diagnostics.test.ts", testOptions);
