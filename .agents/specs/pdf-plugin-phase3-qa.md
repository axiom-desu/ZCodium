# pdf-plugin Phase 3：pdf_qa 清-room 重写（A4c）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

pdf-plugin 的 Phase 1（路由技能 + brief）与 Phase 2（MIT 派生的渲染/表单工具集）
已落地并注册。原版另有约 12,378 行 / 7 个脚本未补，其中 `pdf_qa.py`（899 行）
是一个 PDF 质量检查器，与 `documents-plugin` 的 `postcheck.py` 同构。

选它作为 Phase 3 的第一个标的，理由：

1. **同构**：我们已有 `postcheck.py`（11 条规则，含 planted-defect 反向验证）的
   完整先例，模式可复用。
2. **自包含**：只依赖 `os`/`re`/`sys` 标准库加 poppler 工具链，无重型依赖。
3. **可验证**：本机有 `soffice` 与 `pdftoppm`/`pdftotext`，能构造真实 PDF 做正反向验证。
4. **互补**：Phase 2 的 MIT 脚本负责渲染与表单，`pdf_qa` 负责产出物的质量门。

其余 6 个脚本（`pdf.py` 3076 行、`design_engine.py` 2816、`toc_validate.py` 2069、
`poster_validate.py` 1336、`cover_render.py` 487、两个 `.js`）体量更大，
另立 A4d，不在本次范围。

## clean-room 边界

`pdf_qa.py` 是 Z.AI 专有实现，没有 MIT 基座。按
`documents-doc-layer-cleanroom.md` 的方法论执行：

- 本规格是**看过原作的一侧**产出的规格，定义接口与验收场景。
- **实现者不得读取原作**（`/tmp/opencode/origdocx/`、`origfull/`、仓库根 `*.deb`/`*.dmg`），
  只按本规格实现。
- 实现语言与风格参照我们自己的 `postcheck.py` 家族，不参照原作代码结构。

## 范围

### 纳入

`skills/pdf/scripts/pdf_qa.py` 一个文件，≤400 行，15 项检查。

### CLI 契约

```
python3 pdf_qa.py <file.pdf> [more.pdf ...] [--poster] [--skip-cover] [--no-tables] [--formulas]
```

- 位置参数接受 glob（批量为多个文件时逐份报告，之间空行分隔）。
- 无参数打印用法并 `exit 1`；文件不存在 `exit 1`。
- `--poster`：海报模式，启用封面出血检查。
- `--skip-cover`：跳过首页边距对称检查。
- `--no-tables`：关闭表格居中检查。
- `--formulas`：启用公式溢出检查。
- 退出码：全部通过为 0；存在 ERROR 级问题为非 0。

### 判级模型

参照 `postcheck.py` 的 `Finding` 形态：每条结论带 severity（`ERROR`/`WARN`/`OK`）、
类别、可读消息。报告按人可读排版，同时提供机器可读输出的能力（与 `postcheck.py --json`
一致的做法）。

### 15 项检查（验收场景）

| #   | 检查                    | 必须检出的缺陷                                       |
| --- | ----------------------- | ---------------------------------------------------- |
| 1   | `last_page_fill`        | 末页几乎全空（单页文档跳过）                         |
| 2   | `punctuation`           | 标点问题（中英文标点混用等）                         |
| 3   | `blank_pages`           | 空白页                                               |
| 4   | `colors`                | 颜色使用问题                                         |
| 5   | `page_size_consistency` | 多页文档页尺寸不一致（单页跳过）                     |
| 6   | `text_overflow`         | 文本溢出页面/容器                                    |
| 7   | `content_fill_ratio`    | 中间页填充率过低（<40% 警告）、末页过低（<25% 警告） |
| 8   | `cover_bleed`           | 海报模式下封面背景留边超过 5%（仅 `--poster`）       |
| 9   | `margin_symmetry`       | 页边距不对称（首页可被 `--skip-cover` 跳过）         |
| 10  | `table_centering`       | 表格未居中（可被 `--no-tables` 关闭）                |
| 11  | `font_embedding`        | 字体未嵌入                                           |
| 12  | `helvetica_in_cjk`      | CJK 文本使用 Helvetica 类不支持字体                  |
| 13  | `metadata`              | 元数据缺失                                           |
| 14  | `toc_without_cover`     | 有目录却无封面（单页跳过）                           |
| 15  | `formula_overflow`      | 公式溢出（仅 `--formulas`）                          |

阈值（填充率 40%/25%、出血 5%）是原版采用值，作为起点保留；实现中提取为命名常量，
不要散落字面量。

## 依赖现实（必须如实）

| 依赖                | 用途               | 缺失时行为           |
| ------------------- | ------------------ | -------------------- |
| poppler `pdftotext` | 取文本与布局       | 明确报错，不静默跳过 |
| poppler `pdfinfo`   | 取页尺寸与元数据   | 明确报错，不静默跳过 |
| poppler `pdftoppm`  | 渲染（如检查需要） | 明确报错             |

缺失时返回可读错误并给非 0 退出码，不得假装通过。

## 状态所有者与契约

- `pdf_qa.py` 是 pdf-plugin 的质量门，与 Phase 2 的 MIT 脚本互补，不重复。
- SKILL.md 必须新增一节描述它，含 CLI、15 项检查、依赖与失败语义。
- `requiredSeedPaths` 必须包含 `skills/pdf/scripts/pdf_qa.py`。
- 不引入 pypdf/pdfplumber 等新依赖——原版就是纯标准库，没有理由变重。

## 验收场景

1. `pdf_qa.py` 存在且 ≤400 行；`pnpm typecheck`、`pnpm lint` 保持基线
   （57 warnings / 0 errors）。
2. **正反向验证（硬门槛，必须做）**：
   - 用 `soffice` 从干净样本转出一个 PDF，跑 `pdf_qa.py`，记录结论；
   - 构造或选取含缺陷的 PDF（至少覆盖：空白页、页尺寸不一致、字体未嵌入、
     CJK 用 Helvetica、末页近乎全空中的三项），确认对应检查报出问题；
   - 对干净 PDF 不误报。
3. **CLI 契约**：无参 → 用法 + exit 1；不存在文件 → exit 1；`--poster`/`--skip-cover`/
   `--no-tables`/`--formulas` 四个开关各自改变行为；glob 批量逐份报告。
4. **非空转证明**：对单项检查做变异（改阈值、改判定条件），确认报告结论随之改变。
5. **机器可读输出**：`--json` 或等价能力存在且可解析。
6. SKILL.md 新增节描述它，且不引用任何仍不存在的脚本。
7. `requiredSeedPaths` 覆盖新脚本，四处契约一致。
8. 不引入 `__pycache__`、`*.pyc`。

## 非目标

- 不实现 A4d 的其余 6 个脚本。
- 不追求与原版 15 项检查的实现方式或报告文案一致——只需检查项与判级语义对齐。
- 不改 Phase 1/2 的任何文件（SKILL.md 新增一节除外）。
