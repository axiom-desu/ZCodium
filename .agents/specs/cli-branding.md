# CLI 用户可见品牌

## 产品规则（实现前）

用户指出 CLI 仍残留上游 ZCode 的 Mark。用户可见的品牌统一到当前仓库的 ZCodium：TS CLI/TUI 使用 ZCodium；Rust CLI/TUI 使用 ZCodium Rust。覆盖当前实际存在的帮助页标题/描述、终端启动标题和空会话 Logo；不是全仓字符串替换。

- 复用现有 i18n/copy 与 TUI 组件所有者；中英文同步，不引入第二套 locale 或品牌状态。
- 不更名内部 `@zcode/*` 包、协议名、环境键、配置目录/字段、RPC 方法、兼容命令、二进制文件名、日志 scope 或历史会话标识；这些不是 UI Mark。
- 不改变 runtime 选择、参数解析、数据路径或网络默认值。保留既有许可证/版权/上游出处。
- TUI Logo 长度变化仍受现有终端宽高约束，窄屏应正确隐藏/缩排，而不是扩大硬编码布局。

## 验收

- 从实际 copy/help 入口及 Logo 渲染规则验证 ZCodium，不能仅 grep 声称全改；保留参数/兼容接口回归。
- Rust 真 PTY 断言 ZCodium Rust 标题；TS TUI/CLI 现有可执行测试中检查新显示品牌。模型密钥不写日志。
- 本轮只本地修改与打包/测试，用户明确不允许公开安装包、push/tag/release。

## Exp 侧栏遗漏补充（打包前）

- 常驻侧栏产品名也属于用户可见品牌，使用 ZCodium；继续由 `app-sidebar.tsx` 的静态展示常量唯一维护，不新增状态、配置键或后端品牌字段。
- 保留已有 `displayWidth(PRODUCT_NAME)` 与版本剩余列宽计算，不硬编码新宽度；不改变侧栏显隐、折叠或 runtime/session 行为。
- 中英文真实 TuiApp renderer 使用能展开侧栏的终端宽度，断言标题与版本为 `ZCodium fixture`，并断言没有独立的上游 ZCode 品牌；不能只测试帮助、空会话 Logo 或默认隐藏侧栏的窄窗口。
- 先让该回归在旧侧栏常量下失败，再修正并通过；本轮只重打本地 Linux x64 Exp deb，并从包内公共 CLI 入口核对侧栏与 Mark，保留 Rust 包与全部无关本地改动，不安装或公开安装包。

### Exp 侧栏补充验收结果

- 新增宽终端真实 TuiApp 断言先在旧 `ZCode fixture` 标题下失败；修正静态产品名后，中英文测试通过。
- 仅重打 Exp Linux x64 deb：`/tmp/zcodium-exp-branding/ZCodium Exp-3.15.1-20261018.374-linux-amd64.deb`，SHA256 `10425a17df6f7f2a9673290cad8f9c75b04f6ac490902f0caadeb39fba3d2c83`。滚动版本未变，需显式重新安装；没有替用户安装。
- 解包后的公共 `--cli` 真 PTY 使用隔离 HOME 与本地 fixture，实际捕获新版 Mark 和 ZCodium 版本侧栏、无独立 ZCode 品牌；Ctrl-C 130、终端恢复通过。OpenTUI 屏幕用成熟 pyte 还原，不能复用仅支持部分 Ratatui ANSI 的重建器或把模型名是否出现当作品牌验收前提。
- 新 deb GUI 对话、Read/模型工具回灌、同 HOME 重启恢复、带历史追问等八步通过。358 项脚本测试、根与 TUI typecheck、架构、格式检查（排除既有 logs）通过；Lint 0 errors、50 条既有 warnings。
- Rust 旧产物 SHA256 仍为 `6e1470faee37f12e0c97bfa14323c99ea6da01a77092d627369b56128c33afab`，未重打或改动该包。没有 push/tag/release，没有触碰真实用户配置或既有 logs。

## 本轮实现与验证

- TS 空会话/启动 Mark 改为七字 ZCODIUM；按实际 pane/terminal 宽度选择大 Logo、小字标或隐藏，保留 shimmer 与 resize。中英文帮助标题与启动提示改为 ZCodium；`zcode` Usage 是现有兼容命令，不做虚假的二进制改名。
- Rust TUI 原标题已经是 ZCodium Rust；补齐原 Rust CLI about/help 的可见品牌，并列出公共 `zcodium-rust --cli` 用法。ZCode Protocol、内部函数/包名、日志 scope 和配置键不改。
- 纯 copy/宽度回归和真实 OpenTUI renderer 的宽/窄终端测试通过；新版 Exp deb 的公共 `--cli --help` 输出 ZCodium CLI，真实 PTY 捕获完整 ZCODIUM Mark，Ctrl-C 返回 130 并恢复终端模式。
- 新版 Rust deb 的公共入口 PTY 标题/多轮测试通过。不把临时 profile 和安装包发布到仓库，两个产品的安装包均仅保留在本机 `/tmp/zcodium-cli-fix/`。
