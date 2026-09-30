# ZCodium

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCodium" width="128" height="128" />
</div>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

<p align="center">
  <em>"为什么我们这么坚持开源？因为这个愿景本身就要求开源。你没有这个愿景，你没法把人组织起来。比如说，智谱也开源，但是智谱的开源跟我们的开源不一样。智谱的开源有一种被迫的感觉，他们觉得这不是本意，但是对我们来讲，这就是我们的本意。"</em><br />
  <em>—— 梁文锋，深度求索 CEO</em>
</p>

ZCodium 是 ZCode 的社区衍生仓库。上游 ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent；本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## 这个仓库是什么

上游在 2026-09 被迫将 ZCode 客户端开源，但开源出来的源码与他们实际发布的安装包并不等价：发布包里带有一批开源代码中没有的功能。ZCodium 的做法是**跟进上游官方仓库，同时把这些"只在发布包里存在"的功能以各种方式补全**，让自建的源码能够构建出与官方包能力对等的产物。

补全手段包括：补齐缺失的内置插件与技能、比对 i18n 键定位功能缺口、按协议与设置 schema 对齐交互链路。所有补全都记录在 [.agents/specs/](.agents/specs/) 下的 spec 中，包含范围、状态所有者、接口契约与验收场景。

[另外一个ZCodium](https://github.com/ZCodium-project/ZCodium)

[嘘... 别让用户发现我们在干什么](apps/zcode-cli/tools/repo-snapshot-parody/README.md)

### 与官方包的能力差异

以下按**官方 3.14.3 安装包**核对（`ZCode-3.14.3-win-x64.exe`，`appVersion: 3.14.3`，构建于 2026-09-22）。核对方法：从安装包取出 `resources/app.asar` 内 `out/renderer/assets/IntlProvider-*.js` 的语言表，与 [packages/ui/src/i18n/locales/](packages/ui/src/i18n/locales/) 做键差集。上游随 3.14.3 新开源的内容已计入下表，不再是“待核对”状态。

**已补全**：

- 内置插件与技能：documents、pdf、presentations、spreadsheets、skill-creator、plugin-creator、image-search、restore-legacy-sessions、zcode-guide、zcode-cua。安装包只分发源码资源完整且明确注册的插件；范围见 [.agents/specs/builtin-plugin-parity.md](.agents/specs/builtin-plugin-parity.md)、[.agents/specs/pdf-plugin-backfill.md](.agents/specs/pdf-plugin-backfill.md) 与 [.agents/specs/spreadsheets-plugin-backfill.md](.agents/specs/spreadsheets-plugin-backfill.md)。
- Computer Use 的模型可见面：`apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs`、技能与文档。原生 runtime（koffi/sharp，约 20 MiB）未随包发布，与上游 `runtimeTopLevelPaths: []` 的声明一致。

**尚未补全**（共 258 键）：

| 领域                   | 缺口  | 说明                                                     |
| ---------------------- | ----- | -------------------------------------------------------- |
| ~~`webRemoteControl`~~ | 0 键  | 手机远控桌面已补齐（LAN 直连 + 用户自托管 relay）        |
| `manualClaimPlan`      | 53 键 | 权益领取与验证码流程                                     |
| `mode`                 | 38 键 | 会话模式扩展                                             |
| `settings`             | 26 键 | 含 Claude 模型槽位映射、Anthropic/OpenAI/Gemini 端点模板 |
| `server`               | 12 键 | Server 入口                                              |
| `appHeader`            | 8 键  | Provider 配置入口                                        |
| `marketingTouch`       | 7 键  | 权益触达                                                 |
| `taskList`             | 6 键  | Codex / Claude 新建任务                                  |
| `chat`                 | 5 键  | agent 切换                                               |
| `rewards`              | 5 键  | 权益菜单                                                 |
| `onboarding`           | 4 键  | agent 设置步骤                                           |
| 其他                   | 5 键  | `remote`、`zcode`、`titleBar`                            |

`bots` 的 259 个键已由上游 3.14.3 全部开源并随合并进入本仓库，缺口为 0。`webRemoteControl` 的 89 键已由本仓库补齐（2026-09-29，spec 见 `.agents/specs/web-remote-control.md`）：默认同网扫码直连，桥接桌面已有 Host；用户自托管 relay（跨网）为可选后续。当前最大缺口为 `manualClaimPlan`。反向还有 33 个键是本仓库特有、官方包没有的，主要来自 AstrBot 桥接与 `.zcodium` 命名空间。

**有意不补全**：

- 仓库快照上传。官方 3.14.0 之前的版本会在每次提问前打包整个 workspace（含 `.git`）并加密上传至对象存储，服务端持有私钥。该行为已从上游移除，本仓库同样不实现，仅在 [apps/zcode-cli/tools/repo-snapshot-parody/](apps/zcode-cli/tools/repo-snapshot-parody/) 保留一份 localhost 本地复现用于审计对照——密钥本地生成、默认拒绝非回环目标。
- 官方遥测采集与上报。ZCodium 保留安全的本地诊断，默认无上报；用户可显式配置自己的 OTLP 接收端。详见[诊断说明](DIAGNOSTICS.md)。

### 补全路线

**已落地**：

- **`bots`：官方实现 + AstrBot 桥接并存。** 上游 3.14.3 已开源官方 `bots`
  （四套平台 adapter 与“接哪个平台”的设置 GUI），本仓库已并入。自研的
  [AstrBot](https://github.com/AstrBotDevs/AstrBot) 桥接不再是与官方 `BotsService`
  并行的独立服务，而是收敛为官方 `BotsService` 的一个传输 provider
  （`BotProviderAdapter`，channel 固定为 `astrbot`），已在官方 Bots GUI 与手机远控入口接入；
  平台适配由 AstrBot 承担，本仓库只维护桥接契约（wire 协议 v2）。
  [astrbot-zcodium-plugin](https://github.com/axiom-desu/astrbot-zcodium-plugin)，
  见 [.agents/specs/bots-astrbot-bridge.md](.agents/specs/bots-astrbot-bridge.md)。
- **Computer Use 运行时**：原生执行层不自研，复用开源项目
  [`trycua/cua`](https://github.com/trycua/cua) 的 `@trycua/cua-driver`
  （MIT，Rust，macOS / Windows / Linux），适配器见 [packages/zcode-cua/](packages/zcode-cua/)；
  client 由上层注入，没有 client 时保持 fail-closed。老 GNOME / Wayland 另有一层
  物理输入兼容层。能力对接与缺口、适配器契约与各平台机制分别见
  [.agents/specs/computer-use-capabilities.md](.agents/specs/computer-use-capabilities.md)、
  [.agents/specs/computer-use-runtime.md](.agents/specs/computer-use-runtime.md) 与
  [.agents/specs/computer-use-platform-architecture.md](.agents/specs/computer-use-platform-architecture.md)。

**已确定，尚未动工**：

- **image-search 默认指向本地**：已改为 `http://127.0.0.1:8787`，见
  [.agents/specs/image-search-local-backend.md](.agents/specs/image-search-local-backend.md)；
  仓库内暂无本地搜图后端，需要自行部署。

### 与上游的关系

本仓库跟踪上游 [zai-org/ZCode](https://github.com/zai-org/ZCode)。上游更新时先合并，再重新核对能力差异；补全内容按功能拆成独立提交，方便逐项审查与取舍。许可证与第三方版权归属见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)。

**既定规则**：上游发布新功能但不随开源仓库放出对应源码时，本仓库自行补齐等价实现并开源，不等待、不申请、不保留。判断依据是「安装包里有没有」，不是「上游说了什么」。补全内容按功能单独提交，并在 [.agents/specs/](.agents/specs/) 下记录实现范围、决策依据与未验证部分。

| 入口                 | 用途                                                           | 开发命令                       |
| -------------------- | -------------------------------------------------------------- | ------------------------------ |
| Desktop              | Electron 桌面应用                                              | `pnpm dev:desktop`             |
| Web / ZCode 命令行版 | 终端与浏览器工作台；将 TUI、Web、后端和 Agent 组装为独立运行包 | `pnpm dev:web`                 |
| Agent CLI            | 在终端中使用 `zcode`，也为 Desktop 和 Web 提供 Agent 运行时    | `pnpm --filter @zcode/cli dev` |

## 更新

- 2026-09-29：补齐手机远控（`webRemoteControl`）本体：桌面 LAN 直连配对/QR + 桥接已有 Host + `packages/web` mobile entry，89 键全量落地；跨网提供用户自托管 relay 包（`packages/relay`，Docker 一键），本项目不运营任何中转（[spec](.agents/specs/web-remote-control.md)）。
- 2026-09-24：AstrBot 桥接整合为官方 `BotsService` 的传输 provider，并在官方 Bots GUI 与手机远控入口接入（#11–#14）。
- 2026-09-24：按官方 3.14.3 安装包重新核对 i18n 键缺口，`bots` 259 键已归零，剩余 258 键；核对方法记入「与官方包的能力差异」。
- 2026-09-24：Computer Use 运行时改为复用 `@trycua/cua-driver` 作为唯一原生引擎，移除自研 desk-pilot；client 由上层注入，缺失时保持 fail-closed，老 GNOME / Wayland 另走物理输入兼容层。
- 2026-09-24：合并上游 3.14.3（`328c1a0`），纳入官方 bots 与手机远控等新开源内容；继续保留 `.zcodium` 数据命名空间。
- 2026-09-24：根目录 `package.json` 版本改为 `3.14.3-modified`，用于标识本仓库产物，详见下方「版本标识」。

## 版本标识

根目录 `package.json` 的版本号在上游版本后带 `-modified` 后缀（当前 `3.14.3-modified`），用于把本仓库产物与官方包区分开。该后缀是合法的 semver 预发布标识，`node scripts/ci/desktop-release.mjs check-version` 会接受它。

发布标签必须与版本严格一致，即 `v3.14.3-modified`；CI 产物名随之变为 `ZCodium-3.14.3-modified-<platform>-<arch>.<ext>`。命令行发行包的默认版本同样取该值，因此 `dist/zcode/releases/3.14.3-modified/` 是默认输出目录。

注意：`ZCODE_REMOTE_ASSET_CDN_BASE_URL` 若固定到某个版本目录，必须与运行版本一致，否则 `assertRemoteCdnBaseVersionMatches` 会在启动时直接报错。上游没有 `3.14.3-modified` 对应目录，需要自行托管远程资源，或改成不带版本的发布根目录。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcodium-dev-home" pnpm dev:desktop:test
```

内置模型与供应商目录随应用和 CLI 发布，运行时不会从官方服务下载更新，也不会使用历史下载缓存。个人模型、API 密钥与自定义端点仍通过现有设置管理。

### 远程功能（SSH/WSL）

Linux x64 与 Windows x64 桌面安装包内置 Linux x64 远端运行资源。连接 SSH、WSL 或 Linux 容器时，应用校验随包组件并上传安装；远端无需访问组件 CDN。已有匹配组件会复用，缺少必需文件时自动修复。目前远端目标仅支持 Linux x64。

开发时先执行 `pnpm bootstrap:with-remote`，再 `pnpm dev:desktop`。修改 Server、Agent 或内置插件后，运行 `pnpm prepare:remote-assets` 重建 `packages/desktop/bundled-remote-assets`。构建阶段需要获取固定依赖；运行时缺少或损坏的资源会明确报错，不联网补下载。

Web 开发使用同一份本地资源。独立部署 HTTP 服务时，通过 `ZCODE_BUNDLED_REMOTE_ASSETS_DIR` 指定该服务所在机器上的资源目录；它必须与服务版本匹配，浏览器不能覆盖这个路径。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

### UI Plugin 开发

参见 [UI Plugin：能力、API 与调试](UI_PLUGIN.md)，从 Excalidraw 的画布协作示例开始，了解插件安装更新、页面 API 和宿主联调入口。

**向 `zcode-plugins` 提交插件 PR 时，必须在 PR 模板中声明是否为 UI Plugin，并填写插件名称。** 判断标准见[提交 PR 时声明插件类型](UI_PLUGIN.md#提交-pr-时声明插件类型)。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcodium/`       |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

### 自动构建与发布

[Desktop CI](.github/workflows/desktop.yml) 在 PR、main 推送和手动运行时检查代码，并用原生 runner 构建 Linux x64/arm64、Windows x64/arm64 与 macOS arm64/x64。Linux 产物为 AppImage、deb、rpm、pkg.tar.zst，Windows 为 exe，macOS 为 dmg/zip；可从 Actions 页面下载，保留 14 天。

推送 `v<package.json.version>` 标签会在全部检查和全平台构建成功后创建**草稿 Release**，附安装包和 `SHA256SUMS`。版本允许预发布标识（如 `-rc.1`），不接受 build metadata。维护者测试后手动公开发布；重新运行可补传草稿资产，不会覆盖已公开版本。手动运行工作流只生成构建产物。

流程使用仓库自带的 `GITHUB_TOKEN`，无需额外服务凭据或签名证书。安装包未签名；应用内更新和独立远程运行资源不由此流程发布。规则见 [CI/CD spec](.agents/specs/desktop-ci-release.md)。

第三方声明由 [scripts/generate-third-party-notices.mjs](scripts/generate-third-party-notices.mjs) 依据 [third-party/](third-party/) 下的清单、源码副本与许可证文本生成，产物为随发行物分发的 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；命令行发行包的组装与校验见 [scripts/zcode-distribution/](scripts/zcode-distribution/)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcodium/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `packages/model-option-map`                          | 模型选项映射编译                           |
| `packages/formal-proof`                              | 产品行为状态空间枚举器                     |
| `packages/zcode-cua`                                 | Computer Use 运行时适配器                  |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |
| `harness/remote`                                     | 远程工作区联调用的 SSH Docker 镜像         |

ZCodium 新增的内容：

| 路径                                         | 职责                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `.agents/specs/`                             | 能力补全的 spec：范围、状态所有者、接口契约与验收场景 |
| `.agents/skills/`                            | 编码代理技能：架构治理、Electron、React 等            |
| `apps/zcode-cli/packages/*-plugin`           | 内置插件与技能源码                                    |
| `apps/zcode-cli/tools/repo-snapshot-parody/` | 仓库快照上传的 localhost 复现，仅用于审计对照         |
| `docs/`                                      | GitHub Pages 落地页                                   |

编码约定、开工前基线检查与各领域规范见 [AGENTS.md](AGENTS.md)；插件商店领域词汇见 [CONTEXT.md](CONTEXT.md)，UI 设计规范见 [DESIGN.md](DESIGN.md)。

磁盘上的 `astrbot-zcodium-plugin/` 是配套 AstrBot 插件的独立仓库工作副本，不在本仓库版本控制内，克隆本仓库不会得到它。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
