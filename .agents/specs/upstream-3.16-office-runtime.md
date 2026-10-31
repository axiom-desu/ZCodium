# S10：office-runtime、四文档插件与许可分发闭包

父规格：upstream-3.16-sync / upstream-3.16-project-ui。来源：3.16.1 `0a1fc56d` 新功能与
3.16.2 `3c5b2276` 最终 `@zcode/office-runtime@0.2.0` / 四插件源。用户授权同步全部四格式，不拆成假完成的空包。

## 设计决定

- 采纳共享 office runtime 与 docx/xlsx/pptx/pdf 四个面板；不改写成 Rust UI，不合并现有 renderer Preview Pane。
  两个沙箱边界各有 bundle 是本次明确成本，不跨包导入 renderer 实现。
- DocumentOwner 是每个 MCP 进程的文档/解析缓存/当前视图/选区/分块句柄唯一 owner；panel 与 tools 只通过它操作。
- 查看/搜索不修改用户文档。用户主动文件选择后导入的副本是唯一写路径：按源 importer 的串行准入/4 槽/大小上限/
  未完成文件清理规则执行，只写其专有 import 目录、不修改原文件、不删除成品；只读工作区明确退化。
  原文档中“never writes workspace files”须据此纠正，不能一面声称只读一面隐藏写入。
- 插件名来自当前 `.zcodium-plugin/plugin.json`；MCP 名/surface id/`ui://<name>/` 同源。
  `@zcode/*`、环境变量、协议键、版权保留；只适配现有插件目录约定和用户可见 ZCodium 品牌。
- 运行产物自包含，运行时不依赖 office node_modules。Preview Pane 现有渲染器不删除、不升级。
- 字体/解析器为 office-runtime 的 build-only devDependencies，不额外塞进 packages/ui 生产依赖，
  不破坏 PDF 独立渲染脚本 peers 边界。两份真实 pnpm lock 通过当前包管理器生成，不手填依赖图。
- 构建 ABI 是 office-runtime 的公开 `bin`：`zcode-office-build` / `zcode-office-smoke` /
  `zcode-office-e2e` 分别映射到带 shebang 的 `scripts/*.mjs`；四个插件只调用 bin 名，不再用
  `node ../office-runtime/scripts/*.mjs` 相对文件名。bin 仍以插件根目录（`process.cwd()`）为构建目标，
  Windows pnpm shim 与 `prepare-prebuilds`/desktop bootstrap 的 staging 行为不变。
  knip 由图上的 script→bin→workspace 依赖推断 `@zcode/office-runtime` 使用，因此不新增
  `ignoreDependencies`/`ignoreIssues`：真正死掉的导出应删除或收窄，不能用忽略掩盖。
  esbuild 的 pdf.js 补丁会静态 import `ui/cjkFontRuntime.ts` 的 `pdfTypeface`，该文件因此登记为
  真实构建入口；其余无消费者的导出按内部符号收窄，不保留伪 import/伪 entry。
- 新 managed module 使用真实 domain/app/adapters/ui 层、公开 contract/module/example/docs 和 policy；
  每文件 ≤400、contract ≤300，不复制新豁免。Office 控件遵守 DESIGN 字体/颜色/交互规范；文档正文保留独立排版。

```text
plugin manifest office profile → reviewed build (kind filter, version-bound patches)
  → server.mjs + panel/assets + notices (self-contained)
  → filesystem/SEA/desktop/remote same plugin tree

Agent/read app → stdio MCP → DocumentOwner → snapshot / resource chunks
  → existing MCP Apps sandbox (no network) → one App instance → report_view / selection

user file picker → explicit import admission → private partial copy → checked completed file
  → same DocumentOwner open flow; never mutate the source file
```

## 依赖/材料准入（不是豁免）

已只读验证材料：`/tmp/upstream-office-materials`；仓库登记证据位于
`third-party/upstream/office-runtime/`；187 个原 npm archive SHA512 全部匹配。
必须按最终 lock 的精确版本复核，不把当前 range 解析当未来锁承诺。现有 16 项 strict reviewRequired 不关闭或挪走。

- root `licenses check` 标识阶段扫描全实装集（prod+dev），NOTICE 阶段仅生产图，两者不能混淆。
- 真实 esbuild metafile 已证明 office 产物为 29 个 JS 包 + 字体；archiver/unzipper/tmp/fast-csv 为显式 build stub，
  其 157 包安装子树不进入产物；不意味着它们绕过 root 标识门禁。
- 准许按精确 name+version+原始标识+固定证据登记三项：
  - `@fontsource/noto-sans-sc@5.3.1` / OFL-1.1：完整 LICENSE SHA256
    `18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3`，原样 400.css 与 97 个 WOFF2 分片
    （2,382,648 bytes）逐文件 hash。未声明 RFN，仍不改名/子集化/修改字体、不单独售卖，原版权与完整 OFL 必须随产物。
  - `buffers@0.1.1` / 发布元数据缺标识：绑定 npm 原文代码 SHA256
    `97801e296ba5f3c32242f647e1daac5917e300367fed7935ab1e62f40adb1b8a`
    与发布方固定提交 `bitpay/node-buffers@1b745ee…` 的 MIT/X11 元数据证据；只说明识别依据，不能编造缺失 LICENSE。
  - `chainsaw@0.1.0` / MIT/X11：绑定该精确发布元数据与固定证据，不能按 MIT 前缀泛化放行。
- 三项机制需 fail closed：不同包/版本/标识、改变证据/原文/代码/字体分片均拒绝；不得扩 GREEN 正则或新增宽泛 allowlist。
  登记保留证据与义务，不将原 strict 材料积压改成通过。
- 真正分发的 `saxes@5.0.1` 与 `@nodable/entities@3.1.0` 缺包内 LICENSE：使用各发布方固定 tag 原文快照，
  不拼写通用许可文本；isarray 使用仓库已有完整 README MIT 原文材料。仅安装的 binary/buffers/chainsaw 不伪造 NOTICE。
- 构建 NOTICE 按真实 metafile + 字体资源收集，缺完整原文直接失败；验证 stub 包不在分发集合。
  不能因 root 生产图忽略 build-only 而漏掉自包含 bundle 的义务。
- 原始材料/字体/LICENSE 不格式化。依赖准入后用真实 notices 生成器更新根输入/inventory；strict 16 如实报告。

## 资产与宿主接口

- office profile 按插件种类裁剪 parser/viewer；Windows CRLF 下 kind filter 结果相同。
- `OFFICE_RUNTIME_OUTPUTS` 至少 server.mjs / ui/assets.json / ui/panel.html，加实际字体/worker/wasm/通知闭包。
  shared seed、official versions、SEA、dev agent、desktop node bundle、remote stage 都需真实消费；缺任一 required asset fail closed。
  不能仅检查三个入口文件：由经过校验的 assets manifest 展开所有资源并验证路径/存在/大小/哈希，
  包括字体 97 片、worker/wasm 和完整 NOTICE；删除其中任一项，各 staging 消费者必须真实拒绝。
  dev/filesystem 与 SEA 的 bootstrap seed 也是消费者：写入 staging 后、promote 成官方插件缓存前，
  必须用同一份 Node 适配器校验 staged 目录的完整闭包；不合格按「seed 不完整」单插件降级，
  保留旧可用缓存并只清理本次 staging。fresh checkout 没有 dist 不是通过条件（见最终验收 §2）。
  实现边界：office build 在每个插件 `dist/ui/assets.json` 写入 `{scripts,scriptBytes,files[{path,bytes,sha256}]}`；
  shared 只提供纯 manifest 契约（安全相对路径、按 kind 的 pdf/xlsx 闭包、字体 97 片），Node 适配器负责
  exists/size/hash；server staging、desktop node bundle、remote prebuild 都对 staged 目录跑同一适配器。
  importer 的 10 分钟过期与上游一致是下一次准入/启动时的 lazy sweep，不新增定时器或业务队列。
- 文档插件版本按源三处同步，保留旧技能与 PDF standalone package。bootstrap runtime 不覆盖 manifest 自带 MCP args；
  Rust loader/描述/stdio 同样保留 args/env/UI metadata，不能仅“资产已复制”就声称运行可用。
- PDF standalone 工具的 knip 边界保持独立 project：外层 pdf-plugin 只允许 `@zcode/office-runtime`
  这一个 `workspace:*` build-only devDependency；`playwright`/`pdf-lib` 仍是 standalone 用户显式安装的
  普通 peer，root 生产图不得声明它们。测试必须校验真实 build bin，而不是用 ignore 或伪 import 消 knip。
- 模型只看到 model-visible tools；app-only import/read-token 管理入口不能误暴露给 Rust/TS Agent。
- no-network CSP 不放宽；pdf cmaps/fonts/wasm、xlsx worker/wasm、97 CJK 分片全部经资源读取，4MiB chunk 不超既有 cap。
  仅 pdf/spreadsheets 确实使用 Wasm 的 profile 声明宿主已支持的 wasmUnsafeEval；documents/presentations 不发该能力。
  不加 CDN/connect-src/通用 unsafe-eval。
- MCP UI/tool result metadata 必须抵达既有 Host projection；Rust 若有已重写链路缺口须修复并测试，
  无页面宿主的原生 TUI 不伪造截图/面板成功。Web/手机无新插件 sandbox。

## 验收

1. 两锁/依赖图真实可复验；root 标识三项负例 fail closed、现有 strict 16 仍可见；plugin NOTICE 包集/完整原文与字体 hash 锁。
2. 四插件实际 build，记录资源数与 bundle 大小；不跟踪 dist；所有 staging 声明相同且旧 .395 不动。
3. 原算法与边界：anchor/check/paged text/CJK/parse/cache/selection/reveal.seq；path/symlink/大小/分块token失效；
   importer 顺序/取消/同名/未完成清理与只读降级，禁止改源文件。
4. 四真实 stdio MCP smoke：open/read/search/show/get_view、app-only 不被模型列举；Rust 临时插件树的 manifest/args/env/结果 metadata 验证。
5. 隔离真实浏览器及既有 MCP Apps Host/Electron E2E（按可用实际入口），验证四格式渲染/定位/查找/选区 Add/Ask/截图，
   字体/wasm资源离线可用、无外部请求/控制台错误。不能用解包/纯模型测试冒充 panel acceptance。
6. 现有 Preview Pane、Gen UI、MCP Apps沙箱、三 gate/raw lint0/type/架构/格式与 CLI/Rust回归全部保留。

实现由子任务分工，父会话审查原始材料与跨包接口。只用临时 HOME/XDG/workspace/DB/browser profile/loopback，
不运行未审查上游脚本，不安装应用或替换 .395，不发 tag/Release；环境受限真实记录。
