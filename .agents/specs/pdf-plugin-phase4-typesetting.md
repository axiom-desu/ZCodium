# A4d：pdf-plugin 排版渲染层（Typesetting and Render Layer）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

pdf-plugin 的 Phase 1（路由技能 + brief）、Phase 2（MIT 渲染/表单工具集）、
Phase 3（清-room `pdf_qa` 质量门）已落地。原版另有 6 个脚本未补，共约 12,378 行。

开源普查结论见 `a4d-a1c-openbase-survey.md`：**7 个里只有 1 个真有可运行基座**，
且那个基座在 Node 里跑不动。

## `html2pdf.js` 能借什么，不能借什么

`eKoopmans/html2pdf.js`（MIT，Copyright (c) 2017 Erik Koopmans）的源码结构：

| 文件                         | 行数 | 性质                       |
| ---------------------------- | ---- | -------------------------- |
| `src/index.js`               | 29   | 入口，`html2pdf(src, opt)` |
| `src/worker.js`              | —    | 16 KB，核心 worker         |
| `src/plugin/pagebreaks.js`   | 134  | 分页插件                   |
| `src/plugin/jspdf-plugin.js` | —    | jsPDF 选项插件             |
| `src/plugin/hyperlinks.js`   | —    | 超链接插件                 |
| `src/snapdom/clone.js`       | —    | DOM 深拷贝                 |

它 `import { jsPDF } from 'jspdf/...'` 且 `import html2canvas from 'html2canvas'`。
两者都要求 DOM：`html2canvas` 需要 `document`/`window`/canvas 才能把元素画成位图。
**在 Node 里没有 DOM，这个库跑不起来**，除非引入 jsdom + node-canvas 这类重依赖。

因此本插件**不 vendor 它的代码**，而是：

- **借它的 API 契约与选项语义**（`margin`、`filename`、`image.type`/`image.quality`、
  `pagebreak` 模式、`html2canvas`/`jsPDF` 两个透传配置对象、Promise 化 worker），
  在 NOTICE.md 与文件头署名；
- **渲染路径用本机真实可用的工具**：`soffice --headless --convert-to pdf`。
  已实测：HTML→PDF 得 2 页 A4、文本可提取、`page-break-after: always` 生效。

这与「抄一个跑不起来的库」是不同性质的操作：借的是接口设计，实现落在我们自己的
工具链上。

## 范围

### 纳入（本次，3 个脚本）

| 脚本              | 处置 | 说明                                                |
| ----------------- | ---- | --------------------------------------------------- |
| `html2pdf.py`     | 借   | 选项模型派生自 html2pdf.js（MIT），渲染委托 soffice |
| `cover_render.py` | 写   | 封面渲染：把封面 HTML 渲成 PDF 首页                 |
| `toc_validate.py` | 写   | 目录校验：条目与标题一致、页码非占位                |

### 排除（本次）

`pdf.py`（3076 行 CLI 工具箱）、`design_engine.py`（2816 行设计引擎）、
`poster_validate.py`（1336）、`html2poster.js`（288）。这四个体量大且无基座，
另立 A4e。**不为凑数而产出不可维护的代码。**

## 依赖现实（必须如实）

| 依赖                    | 使用者                           | 缺失时行为                      |
| ----------------------- | -------------------------------- | ------------------------------- |
| LibreOffice `soffice`   | `html2pdf.py`、`cover_render.py` | 明确报错并非 0 退出，不静默跳过 |
| `pdfinfo` / `pdftotext` | `toc_validate.py`                | 明确报错并非 0 退出             |
| poppler `pdftoppm`      | 渲染校验（如需要）               | 明确报错                        |

与 Phase 2 的 MIT 脚本、Phase 3 的 `pdf_qa` 一致：缺依赖时报错，不假装通过。

## 状态所有者与契约

- `html2pdf.py` 与 `convert_pdf_to_images.py`（Phase 2，PDF→PNG）互补，不重复：
  前者 HTML→PDF，后者 PDF→PNG。
- `toc_validate.py` 与 `pdf_qa.py`（Phase 3）互补：`pdf_qa` 管整体质量门，
  本脚本只管目录条目本身。
- SKILL.md 新增一节描述这三个脚本，含 CLI、选项、依赖与失败语义。
- `requiredSeedPaths` 必须包含三个脚本。
- 不引入 Node 运行时依赖——本插件的脚本面是 Python，原版的 `.js` 脚本
  在本次以 Python 等价物落地，SKILL.md 不得再引用 `.js` 路径。

## 验收场景

1. 三个脚本存在，各自 ≤400 行；`pnpm typecheck`、`pnpm lint` 保持基线。
2. **`html2pdf.py` 真实运行**：对含分页的 HTML 产出 PDF，页数与 `pdfinfo` 一致；
   选项（margin/filename/pagebreak）真实改变输出。
3. **`cover_render.py` 真实运行**：产出以封面为首页的 PDF。
4. **`toc_validate.py` 正反向验证**：对目录完好的 PDF 报通过；对构造的缺陷 PDF
   （条目与标题不一致、页码为占位符）报出问题。做变异证明非空转。
5. **署名完整**：`html2pdf.py` 头部含 upstream 项目名、Copyright、MIT 条款；
   `NOTICE.md` 记录派生来源与 delta。
6. SKILL.md 不引用任何仍不存在的脚本，也不引用 `.js` 路径。
7. `requiredSeedPaths` 覆盖三个脚本，四处契约一致。
8. 不引入 `__pycache__`、`*.pyc`、Node 依赖。

## 非目标

- 不实现 A4e 的四个脚本。
- 不 vendor html2pdf.js / jspdf / html2canvas 的任何代码。
- 不引入 jsdom、node-canvas、puppeteer 等重依赖。
- 不改 Phase 1/2/3 的既有文件（SKILL.md 新增一节除外）。
