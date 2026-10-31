# office-runtime

内置文档插件（documents、pdf、presentations、spreadsheets）的查看面板共用这一份运行时。每个插件在自己的 package.json 里用 `office` 字段声明面板标题和格式，并调用本包公开的 `zcode-office-build` bin（映射到 `scripts/build.mjs`）；构建只保留该插件格式的解析器与查看器，输出到插件根目录的 `dist/`。面板、MCP 工具与锚点语法见 [src/CONTRACT.md](src/CONTRACT.md)。

不变量：

- 插件名取自插件的 `.zcodium-plugin/plugin.json`，它同时是 MCP 服务名、面板 surface id 和 `ui://<name>/` 资源前缀；不能从目录名推导（目录名带 `-plugin` 后缀）。
- 构建必定产出 `contract.ts` 的 `OFFICE_RUNTIME_OUTPUTS`。官方插件定义、SEA 清单、桌面打包与远端资产都把它们列为必需资产，改动产物路径时这几处要一起改。
- 产物自包含：`dist/server.mjs` 与面板脚本由 esbuild 打包全部依赖，运行时不读取 `node_modules`；第三方许可随产物写入 `dist/THIRD_PARTY_NOTICES.txt`。
- 查看与搜索不修改用户文档。用户通过系统选择器主动选择并导入的文件是唯一写路径：
  串行准入、最多 4 个未完成槽位、100 MiB 上限、未完成分片清理，只写入工作区的
  `.zcode/document-imports/` 私有副本，不修改原文件、不删除成品；只读工作区退化为仅预览。
