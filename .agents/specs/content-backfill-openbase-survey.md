# A5a：内容插件补全开源基座普查（Content Backfill Open-base Survey）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把 pdf / presentations / spreadsheets / documents 四个内容插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

2026-09-23，GitHub 仓库搜索 API（未认证，10 次/分）+ repos API 核实 license 字段。
目的：为「pdf / presentations / spreadsheets / documents 四个内容插件」的
技能内容层寻找可借用的宽松许可基座。更早的普查见
`a4d-a1c-openbase-survey.md`。

## 本轮最重要的发现：`appautomaton/document-SKILLs` 远比已用部分大

pdf-plugin 的 NOTICE.md 已记录该仓库（MIT，Copyright (c) 2026 appautomaton）是
8 个 pdf 脚本的来源；spreadsheets 规格记录了它是 `xlsx/SKILL.md` 与
`recalc.py` 的来源。本轮拉全树（141 文件）发现它还带有：

| 目录                | 内容                                                                                            | 对口缺口                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pptx/SKILL.md`     | 478 行：Design Principles / Color Palette（18 组配色）/ Visual Details / Layout Tips / Workflow | **presentations 设计层**                                 |
| `pptx/html2pptx.md` | 667 行：HTML→PPTX 转换工作流                                                                    | presentations 生成深度                                   |
| `xlsx/SKILL.md`     | 525 行全量：财务模型颜色规范 / 数字格式 / 公式构造规则 / 禁硬编码                               | **spreadsheets scenes/finance、engines/design、quality** |
| `pdf/`              | SKILL.md + forms/ocr/reference/tables（已部分使用）                                             | pdf references 层                                        |
| `docx/`             | SKILL.md + docx-js.md + ooxml.md + document.py/utilities.py                                     | documents references（我们已换 Python 栈）               |

结论：presentations 与 spreadsheets 的内容缺口**主要可以直接从这个 MIT 仓库派生**，
不需要清-room。这与 pdf 脚本、xlsx recalc.py 是同一路径。

## 逐缺口基座表

### presentations-plugin（缺设计层 ~670 行含量）

| 目标                         | 基座                                               | 许可 | 处置                |
| ---------------------------- | -------------------------------------------------- | ---- | ------------------- |
| SKILL.md 设计章节扩充        | `appautomaton/document-SKILLs` `pptx/SKILL.md`     | MIT  | **借**（派生+署名） |
| `references/design.md`（新） | 同上，Design Principles / Palette / Visual Details | MIT  | **借**              |
| 生成器深度（PptxGenJS 等）   | `appautomaton/document-SKILLs` `pptx/html2pptx.md` | MIT  | 借（按需）          |
| OOXML 细节                   | 已有（我们的 SKILL.md 1–4 章）                     | —    | 保留                |

### spreadsheets-plugin（缺 25 文件 / ~7266 行）

| 目标                  | 基座                                                                             | 许可        | 处置                    |
| --------------------- | -------------------------------------------------------------------------------- | ----------- | ----------------------- |
| `scenes/finance.md`   | `appautomaton/document-SKILLs` `xlsx/SKILL.md` 财务模型章节                      | MIT         | **借**                  |
| `engines/design.md`   | 同上（颜色规范 / 数字格式 / 公式规则）                                           | MIT         | **借**                  |
| `quality/pipeline.md` | 同上（Zero Formula Errors / Preserve Templates）                                 | MIT         | **借**                  |
| `scenes/create.md`    | `jmcnamara/XlsxWriter`（BSD-2，★3975）+ `exceljs/exceljs`（MIT，★15483）公开 API | BSD-2 / MIT | 借 API 事实，**写**文档 |
| `scenes/analyze.md`   | `vega/vega-lite`（BSD-3，★5494）、`observablehq/plot`（ISC，★5386）编码理论      | BSD-3 / ISC | 借理论，**写**文档      |
| `scenes/edit.md`      | `scanny/python-pptx` 无关；openpyxl 公开 API                                     | MIT         | 写                      |
| `scenes/convert.md`   | LibreOffice `soffice` 命令行（公开事实）                                         | —           | 写                      |
| `scenes/vba.md`       | 无可用基座（VBA 资料多为专有文档）                                               | —           | **写**（公开语法）      |
| `templates/base.py`   | XlsxWriter/openpyxl 公开 API                                                     | BSD-2 / MIT | 写                      |
| `xlsx.py` 主工具箱    | XlsxWriter（BSD-2）+ openpyxl（MIT）                                             | BSD-2 / MIT | 写                      |
| `env_setup/` 5 文件   | 字体清单为事实数据；安装脚本为通用 shell                                         | —           | 写                      |

### pdf-plugin（缺 33 文件 / ~17427 行）

| 目标                          | 基座                                                                                                            | 许可                     | 处置                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| `briefs/academic.md`          | `zagoli/simple-typst-thesis`（Apache-2.0，★63）、`jskherman/jsk-lecnotes`（Apache-2.0，★86）                    | Apache-2.0               | 借模板事实，**写**指南     |
| `briefs/creative*.md`（3 个） | `yunanwg/brilliant-CV`（Apache-2.0，★842）、`pagedjs/pagedjs`（MIT，★1514）、`Kozea/WeasyPrint`（BSD-3，★9624） | Apache-2.0 / MIT / BSD-3 | 借，**写**指南             |
| `briefs/process*.md`（2 个）  | 无对口基座                                                                                                      | —                        | **写**（公开技术文档知识） |
| `typesetting/` 10 篇          | `typst/typst`（Apache-2.0，★56188）排版模型、LaTeX 公开文档                                                     | Apache-2.0 / LPPL 文档   | 借概念，**写**             |
| `configs/` 3 篇               | 公开字体/色彩知识                                                                                               | —                        | 写                         |
| `env_setup/` 5 文件           | 通用                                                                                                            | —                        | 写                         |
| `references/*.tex`            | 以上模板的 LaTeX 源                                                                                             | 见上                     | 写                         |

**明确不借**：

- `posquit0/Awesome-CV`（★28565）是 **LPPL-1.3c**，不是 MIT。LPPL 要求修改后文件
  必须改名才能分发，派生进技能目录摩擦大，仅作参考不进 NOTICE 派生清单。
- `deedydas/Deedy-Resume` 仓库已 404/无许可信息，不可用。
- `baposter`（LPPL）同理不用；poster 类用 `gbaydin/oxford-poster`（MIT，★78）等
  beamerposter MIT 派生模板作事实参考。

### documents-plugin（缺 env_setup 3 文件）

| 目标                                                | 基座                       | 许可 | 处置 |
| --------------------------------------------------- | -------------------------- | ---- | ---- |
| `env_setup/font_list.txt`                           | 字体名称为事实数据，无版权 | —    | 写   |
| `env_setup/setup_mac_linux.sh`、`setup_windows.ps1` | 通用 shell/PowerShell      | —    | 写   |

## 许可判定（与上轮一致）

- **MIT / BSD-2 / BSD-3 / ISC / Apache-2.0**：可直接派生，保留版权声明与许可声明，
  在 NOTICE.md 记录来源与 delta。Apache-2.0 额外注意 NOTICE 文件传递。
- **LPPL-1.3c**：真实开源但要求修改后文件改名，仅参考不派生。
- **AGPL-3.0**：不引入。
- **无许可 / NOASSERTION / 404**：不可用。

## 处置原则

1. 有对口宽松许可基座的 → 派生并署名，NOTICE.md 逐条记录来源、许可、delta。
2. 无基座或许可不合的 → 清-room 从公开知识写（排版理论、OOXML/ECMA-376 公开规范、
   库的公开 API 文档）。
3. 每条派生/编写都在 NOTICE.md 留痕；本文件只做决策记录。
4. 先写出来再迭代：不为追求完整而阻塞发布。

## 第二轮实际拉取与使用（2026-09-23 下午）

按「优先去 GitHub 看开源项目」的要求，动笔前实际拉取：

| 拉取物                                                                                                                      | 许可         | 用在了哪                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `appautomaton/document-SKILLs` 全树（141 文件）+ `pptx/SKILL.md`、`xlsx/SKILL.md` 全文                                      | MIT          | presentations `references/design.md`；spreadsheets `scenes/finance.md`、`engines/design.md`、`quality/pipeline.md`         |
| `jmcnamara/XlsxWriter` 仓库树 + `dev/docs/source/working_with_formulas.rst`（572 行）、`working_with_charts.rst`（1674 行） | BSD-2-Clause | spreadsheets `scenes/create.md`、`scenes/edit-patterns.md`、`engines/chart.md`、`engines/chart-templates.md`（API 事实源） |
| `vega/vega-lite` 仓库树 + `site/docs/mark/bar.md`、`site/docs/encoding/*`                                                   | BSD-3-Clause | spreadsheets `scenes/analyze.md`、`scenes/analyze-recipes.md`（编码理论事实源）                                            |

本轮新写的原创代码（无第三方源码进入，仅按公开 API 实现）：
`spreadsheets/skills/xlsx/templates/base.py`、`templates/palettes.py`、`xlsx.py`
（init/inspect/audit/recalc 四个子命令，已实测可运行，audit 反向验证通过）、
三个插件共 13 个 env_setup 文件。许可与事实源记录已写入各插件 NOTICE.md。
