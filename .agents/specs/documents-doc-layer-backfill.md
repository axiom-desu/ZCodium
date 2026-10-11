# documents-plugin 文档层补全（A1b）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

`documents-plugin` 的 `SKILL.md` 与 `agents/visual-judge.md` 已就位并回到四处契约。
原版另有约 10,122 行 / 28 个文件的文档层未补：

| 目录                      | 文件数 | 行数  | 性质                                                   |
| ------------------------- | ------ | ----- | ------------------------------------------------------ |
| `skills/docx/routes/`     | 5      | 697   | create / read / comment / edit / format                |
| `skills/docx/references/` | 10     | 4,644 | OOXML、TOC、设计系统、装饰、图表、公式、FAQ、docx-js   |
| `skills/docx/scenes/`     | 7      | 3,362 | 分文档类型 brief（学术/合同/文案/试卷/公文/报告/简历） |
| `skills/docx/env_setup/`  | 5      | 1,221 | 跨平台环境安装                                         |
| `skills/docx/setup.sh`    | 1      | 214   | 环境安装入口                                           |

### 两个必须先说清的事实

**一、`references/docx-js-core.md`（332 行）与 `docx-js-advanced.md`（273 行）
描述的是 docx-js 这个 JavaScript 库。本插件的实现是 Python**
（`document.py` 等 6 个模块 + 3 个补充脚本）。这两份对我们是**不适用的文档**，
不应照搬，也不应"改写"——正确做法是用一份描述我们真实 Python API 的参考取代它们。

**二、这是 Z.AI 专有文档层，没有 MIT 基座。** 与 `SKILL.md` 同一性质：
按 `documents-doc-layer-cleanroom.md` 的方法论，以我们自己的代码与公开知识为
事实源，不读取原版。

## 范围

### 纳入（本次）

| 产物                       | 派生来源                                             |
| -------------------------- | ---------------------------------------------------- |
| `routes/create.md`         | `Document.__init__` / `save` / `validate`            |
| `routes/read.md`           | `Document.__getitem__` / `XMLEditor.get_node`        |
| `routes/comment.md`        | `add_comment` / `reply_to_comment`                   |
| `routes/edit.md`           | `revert_insertion` / `revert_deletion` / `suggest_*` |
| `routes/format.md`         | `fix_footer_fields.py` / `add_toc_placeholders.py`   |
| `references/python-api.md` | 我们 6 个模块的真实公开面（取代 docx-js 两份）       |
| `references/ooxml.md`      | OOXML 包结构与部件关系（公开知识）                   |
| `references/toc.md`        | `add_toc_placeholders.py` 的真实行为                 |
| `env_setup/setup.md`       | Python + defusedxml 依赖说明                         |
| `env_setup/env_check.sh`   | 依赖自检脚本                                         |
| `setup.sh`                 | 环境准备                                             |

### 排除（本次）

- `scenes/` 7 个文件（3,362 行）：分文档类型 brief，价值高但体量大，另立 A1c。
- `references/design-system.md`（1,797）、`decorations.md`（537）、
  `chart-templates.md`（386）、`math-formulas.md`（276）、`common-rules.md`（419）、
  `faq.md`（323）：同上，另立 A1c。
- `references/docx-js-core.md` / `docx-js-advanced.md`：由 `python-api.md` 取代，
  不创建。

## 状态所有者与契约

- **唯一事实源是实现代码**，不是原版文档。`routes/` 的每个步骤都必须能对应到
  真实的方法或脚本调用。
- **不得引用不存在的脚本或库**：本插件没有 docx-js、没有 Node 依赖，
  `references/python-api.md` 之外的文档不得出现 docx-js 用法。
- `env_setup/` 描述的是**我们的真实依赖**：Python 3.10+、`defusedxml`。
  原版的 Node/docx-js 安装流程不适用。
- seed 路径随落地同步扩充，否则装出"看得见技能、读不到参考"的残缺插件。

## 验收场景

1. 纳入的 11 个文件存在，`pnpm typecheck`、`pnpm lint` 保持基线。
2. **路由可执行**：`routes/` 描述的每个调用都能真实跑通。至少实测：
   - `comment.md` 的 `add_comment` / `reply_to_comment` 流程
   - `edit.md` 的 `revert_insertion` / `revert_deletion` 流程
   - `format.md` 的 `fix_footer_fields.py` / `add_toc_placeholders.py` 流程
     用 `/tmp/opencode/docx-sample/sample.docx` 或其派生样本，给真实输出。
3. **python-api.md 与代码一致**：其中每个类/方法/签名都在 6 个模块里存在；
   反向地，公开面全部有说明。脚本核对。
4. **非复制证明**：纳入的 markdown 对原版对应文件句级重合，表达性内容为 0
   （功能令牌如 CLI 命令、字段名、环境变量名豁免）。
5. **seed 同步**：`requiredSeedPaths` 覆盖全部落地文件，四处契约一致。
6. 不引入 `__pycache__`、`*.pyc`。

## 非目标

- 不补 A1c 的 scenes/ 与其余 references（约 5,159 行）。
- 不创建 docx-js 相关文档。
- 不改任何实现代码。
- 不重新许可任何文件。
