# pdf-plugin 补全（PDF Plugin Backfill）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

RC-CHN 因 seed 契约不满足，把 `documents`、`pdf`、`spreadsheets` 从三处发行清单移除。
`documents` 已补齐并回到四处契约（见 `builtin-plugin-parity.md`）。`pdf-plugin`
目录尚不存在，官方 3.14.1 安装包内的原版结构为：

| 路径                      | 数量 | 性质                             |
| ------------------------- | ---- | -------------------------------- |
| `agents/visual-judge.md`  | 1    | 视觉评审 agent                   |
| `skills/pdf/SKILL.md`     | 1    | 路由技能                         |
| `skills/pdf/scripts/`     | 11   | 真实实现（设计引擎、渲染、校验） |
| `skills/pdf/briefs/`      | 9    | 分文档类型的排版 brief           |
| `skills/pdf/typesetting/` | 9    | 排版知识                         |
| `skills/pdf/configs/`     | 3    | 字体/组件/视觉框架配置           |
| `skills/pdf/env_setup/`   | 5    | 跨平台环境安装                   |
| `skills/pdf/references/`  | 2    | LaTeX 简历模板                   |

原版 `LICENSE.txt` 为 Z.ai 非商业许可，**不随本插件发布**；`license` 字段改为
`Apache-2.0`，来源声明写入 `NOTICE.md`，与 documents/presentations 的处理一致。

## 与 documents-plugin 的关键差异

documents 的 clean-room 路径是「从我们自己的 MIT 派生代码派生文档」。**pdf 没有这条路径**：
它的脚本是 Z.AI 原创实现，没有 MIT 基座可依。因此 pdf 的文档层只有两种来源：

1. **通用 LaTeX / 排版知识**——公开领域，可独立撰写，不触达原作。
2. **原作文档**——禁止。

所以 pdf 的技能层按路径 1 撰写：以 LaTeX、PDF 渲染管线、排版规则的公开知识为事实源，
不读取原版任何文档。这与「参考原作后改写」是不同性质的操作，但**弱于**
documents 那种「引用链完全不经过原作」的强度——因为排版领域的最佳实践集合有限，
独立撰写可能与原作在结论上重合（如「正文行高取 1.5」「页边距 2cm」）。
判定时区分：**事实性结论允许重合，表达与结构必须独立。**

## 范围

### Phase 1 — 可注册（本次范围）

| 产物                                                    | 派生来源                                    |
| ------------------------------------------------------- | ------------------------------------------- |
| `package.json`                                          | 契约字段，`license: Apache-2.0`             |
| `.zcodium-plugin/plugin.json`                           | 契约字段，`name: pdf`                       |
| `NOTICE.md`                                             | 来源声明                                    |
| `agents/visual-judge.md`                                | PDF 页面的视觉评审；协议与 documents 版对齐 |
| `skills/pdf/SKILL.md`                                   | 路由：文档类型 → brief；渲染与校验流程      |
| `skills/pdf/briefs/report.md`、`resume.md`、`poster.md` | 三类高频文档的排版要点                      |

完成后把 `pdf` 加回四处契约，seed 路径为 6 项。

### Phase 2 — MIT pdf 能力集（本次范围）

Phase 1 完成后发现 `appautomaton/document-SKILLs`（MIT）另有 `pdf/` 目录，
提供一套**检查与表单**向的脚本，与原版的排版渲染向不同域但互补：

| 脚本                                | 行数 | 作用                              |
| ----------------------------------- | ---- | --------------------------------- |
| `convert_pdf_to_images.py`          | 40   | **把 PDF 每页渲成 PNG**           |
| `create_validation_image.py`        | 46   | 生成渲染校验图                    |
| `check_fillable_fields.py`          | 17   | 检测 PDF 是否含可填表单域         |
| `extract_form_field_info.py`        | 157  | 抽取表单域信息                    |
| `fill_fillable_fields.py`           | 119  | 填充表单域                        |
| `fill_pdf_form_with_annotations.py` | 112  | 以标注方式填充                    |
| `check_bounding_boxes.py`           | 74   | 校验 `fields.json` 的包围盒无重叠 |
| `check_bounding_boxes_test.py`      | —    | 上一项的测试                      |

**`convert_pdf_to_images.py` 是 Phase 1 缺口的直接补全**：`agents/visual-judge.md`
要求「先把页面渲染成 PNG 再交给 visual-judge」，而 Phase 1 没有任何渲染器，
该工作流在 Phase 1 是不可执行的。

MIT 允许派生并要求署名，因此本阶段与 `spreadsheets-plugin` 同路径：
以 MIT 脚本为基座派生，保留归属声明，不需要 clean-room。

依赖现实（必须如实写入 SKILL.md）：

| 依赖               | 使用者                       | 缺失时行为                 |
| ------------------ | ---------------------------- | -------------------------- |
| `pdf2image`        | `convert_pdf_to_images.py`   | import 失败                |
| `pypdf`            | 表单类脚本                   | import 失败                |
| `Pillow`           | `create_validation_image.py` | import 失败                |
| poppler `pdftoppm` | `pdf2image` 的实际后端       | `convert_from_path` 抛异常 |

### Phase 3 — 未纳入

原版 11 个脚本中的排版渲染向实现（`design_engine.py`、`html2pdf-next.js`、
`html2poster.js`、`cover_render.py`、`pdf_qa.py`、`poster_validate.py`、
`toc_validate.py`）没有 MIT 基座，需从零定义接口契约，工作量与
`document.py` 同级。剩余约 25 个文档同理。

## 状态所有者与契约

- 四处契约清单见 `builtin-plugin-parity.md`；`pdf` 加入后与 `documents` 同规则。
- `requiredSeedPaths` 只列 Phase 1 真实存在的 6 个文件。**不得列 Phase 2/3 的文件**——
  列了会让 staging 直接抛 `missing staged official plugin seed asset`。
- `visual-judge.md` 的输出协议（每页一行 JSON、`category` 枚举
  `Spec | Visual | Design | Unverified`）与 documents/presentations 版逐字一致，
  这是宿主依赖的协议面。
- Phase 2 落地后必须同步扩充 seed 路径，否则装出「看得见技能、调不到脚本」的残缺插件。

## 验收场景

1. Phase 1 的 6 个文件存在，`pnpm typecheck`、`pnpm lint` 保持基线。
2. 四处契约均含 `pdf`，staging 模拟通过（用 `bundled-plugins.ts` 的顶层白名单走一遍，
   6 个必需路径全部可被 seed）。
3. **非复制证明**：Phase 1 的 markdown 对原版对应文件句级重合，表达性内容为 0。
4. **协议一致性**：`visual-judge.md` 的 frontmatter 键、JSON schema 键结构、
   `category` 枚举与 documents 版一致。
5. SKILL.md **不引用任何不存在的脚本**——Phase 1 无 scripts/ 目录。
6. 不引入 `LICENSE.txt`、`node_modules`、`__pycache__`、`*.pyc`。
7. **Phase 2 脚本真实运行**（硬验证）：
   - `convert_pdf_to_images.py` 对一个多页 PDF 输出逐页 PNG，尺寸受 `max_dim` 约束；
   - `check_fillable_fields.py` 对含/不含表单域的 PDF 给出相反结论；
   - `fill_fillable_fields.py` 填充后回读，字段值确实改变；
   - `check_bounding_boxes.py` 对其测试夹具给出 `SUCCESS`，对构造的重叠夹具给出
     `FAILURE`。
8. **Phase 2 署名完整**：每个派生脚本保留 upstream 项目名、Copyright 与 MIT 条款；
   `NOTICE.md` 覆盖新增来源。
9. **Phase 2 后 seed 同步扩项**：`requiredSeedPaths` 必须包含全部落地脚本，
   否则装出「看得见技能、调不到脚本」的残缺插件。

## 非目标

- 不实现 Phase 3 的排版渲染向脚本（`design_engine.py` 等 7 个）。
- 不补 Phase 3 的剩余约 30 个文档。
- 不改 MIT 脚本的行为；派生只允许修正 `requires-python` 为真实可运行版本。
- 不改 documents / presentations / spreadsheets 的任何内容。
- 不重新许可任何文件。
