# 技能脚本 lint 存量清理

## 范围

清理以下脚本的 `max-lines` 与 `no-unused-vars` / `prefer-string-starts-ends-with` 诊断：

- `packages/desktop/electron-builder.config.js`、`packages/desktop/scripts/*`、`node-repl-host/scripts/build.mjs`
- `cli/scripts/sea-official-plugin-assets.mjs`（只处理未使用字段与字符串判断，不改变 lucide 新资产路径）
- `pdf-plugin/skills/pdf/scripts/*`
- `superpowers-plugin/skills/brainstorming/scripts/*`
- `restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/*`

## 不变量

- 保持直接 CLI 的入口、参数、退出码、路径与输出契约；`server.cjs` 的 CommonJS 公开导出不变。
- 不用 `eslint-disable`、ignore、压行、`any` 或假 export 消除诊断。
- 拆出的是职责模块，不是把单个超长函数原样搬到新文件。
- 新增 helper 放在现有 `scripts/` 目录下；插件打包按顶层目录复制，因此 helper 会自动进入安装包与远端资产。
- `packages/shared/src/builtinPluginAssets.ts` 是必需资产清单而非完整文件清单，本次不越域修改共享 registry。
- 测试只用 `mkdtemp` fixture；不读取真实用户目录、会话、配置或日志。

## 行为锁定

- `html2pdf-next.js` 的浏览器/pdf-lib 解析、预渲染钩子、pdf-lib 后处理分别拆到 `html2pdf-render-support.js`、`html2pdf-prerender.js`、`html2pdf-postprocess.js`。
- `server.cjs` 的 RFC 6455 帧处理拆到 `websocket-protocol.cjs`，模板/认证/平台辅助拆到 `companion-support.cjs`。
- `restore-conversation.mjs` 的纯值转换、计划构建、消息 part 构建拆到 `restore-values.mjs`、`restore-plan.mjs`、`restore-parts.mjs`。
- 对应测试：`html2pdf-support.test.mjs`、`companion-support.test.mjs`、`restore-conversation.test.mjs`。
