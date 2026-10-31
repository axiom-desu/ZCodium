# 桌面产物保留 `node:` 模块前缀

## 背景与问题

`packages/desktop` 的 main / host / scheduler / preload 由 tsup 打包。tsup 默认
`removeNodeProtocol: true`，其 `nodeProtocolPlugin`（`tsup/dist/index.js`）把所有 `node:*`
import 改写成裸模块名并标记 external。

对 `fs`、`path`、`crypto` 这类内置模块这是无害的：裸名仍能解析。但对 Node 新增的
`node:sqlite` 不是——`sqlite` 不是 npm 包名，而是「必须带 `node:` 前缀」的内置模块。

实测（本轮构建 + 隔离 HOME 启动真实产物）：

```
Desktop CLI bootstrap failed: Cannot find package 'sqlite' imported from
  packages/desktop/out/main/chunk-H4SDSYQD.js
```

即 ESM 静态 import 在模块求值前解析，主进程在任何窗口出现之前就退出。这不是环境问题：
同一份源码用 esbuild 直接打包（`packages/shared/src/sqlite-migrations/backup.ts`）输出为
`import { DatabaseSync } from "node:sqlite"`，证明改写发生在 tsup 的插件层。

历史上 `packages/services` 的三处 `node:sqlite` 消费方（`taskIndexRepo`、
`automationRepo`、`tasksDatabase/startup`）与 `chromeCookieManager` 已用
`require("node:sqlite")` / `createRequire` 绕开了这个改写；新增的
`packages/shared/src/sqlite-migrations/{backup,restore}.ts` 是值 import，绕不开，
于是把已有隐患变成了启动阻塞。

## 产品规则

- 桌面 node 侧产物（main / host / scheduler / preload）必须原样保留源码中的 `node:` 前缀，
  构建期不得把 `node:*` 改写成裸模块名。
- 判定归构建配置所有：源码不需要为了打包器行为写 `require()` 变通。
- 渲染进程（Vite，浏览器平台）不适用本规则：那里出现 `node:*` 本身就是错误。

## 所有者、接口与事件顺序

- 所有者：`packages/desktop/tsup.config.ts`。新增共享常量
  `desktopTsupNodeProtocolOptions = { removeNodeProtocol: false }`，与既有
  `desktopTsupBundleSecurityOptions` 同层展开到所有 `platform: "node"` 的 config。
- 依赖方向不变：tsup 插件只决定 externals/specifier，不改变模块解析顺序；
  运行时解析仍由 Electron 内嵌 Node（≥ 22）完成，`node:sqlite` 前缀被完整保留。
- `platform: "browser"` 的 `plugin-sandbox-alias` 配置不展开该常量。

## 验收场景

1. 构建产物静态检查：`packages/desktop/out/{main,host,scheduler}` 内不存在裸 `"sqlite"`
   specifier。
2. 真实启动：隔离 HOME/XDG/userData 下用 Playwright `_electron` 启动
   `packages/desktop`（`out/main/index.js`），进程不再以
   `Cannot find package 'sqlite'` 退出，渲染进程能拿到窗口。
3. 配置守卫：`scripts/ci/desktop-bundle-node-protocol.test.mjs` 断言所有 node 侧 config
   展开 `removeNodeProtocol: false`；产物存在时追加产物断言。

## 非目标

- 不改写 `packages/shared/src/sqlite-migrations` 的 import 形式（那是 wart 规避，不是边界）。
- 不扩大 `external` 列表来「顺便」处理其它包；`node:` 前缀保留已覆盖整类问题。
- 不触碰安装包/发布流程、不替换已安装的 Electron/Node 二进制。
