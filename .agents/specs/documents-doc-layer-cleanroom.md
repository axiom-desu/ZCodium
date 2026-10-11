# 内容插件文档层 clean-room 派生（Clean-room Doc Layer Derivation）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

`documents-plugin` 缺 `skills/docx/SKILL.md` 与 `agents/visual-judge.md`，因此无法回到
三处发行清单（见 `builtin-plugin-parity.md` 的状态所有者表）。补这两个文件有两种做法：

1. **改写原版文档层**——把官方安装包里的 `SKILL.md` / `references/` / `routes/` 等
   用自己的话重写一遍。
2. **从我们自己的代码派生**——以 `scripts/` 下的实现为唯一事实源，写它实际提供的能力。

本规格选定做法 2，理由是它同时解决法律风险和工程质量两个问题。

### 为什么不是做法 1

clean-room 的严格定义是**双组隔离**：看过原作的一组只产出规格，未看过原作的另一组
按规格实现，两侧不直接传递原作文本。这个前提在当前已经不成立——官方安装包内的原作
在历次等价性比对中已被充分阅读，墙已经翻了。事后无法补建一道有效的墙。

在墙已翻的前提下"重写原版文档"，法律上仍然是**参考原作形成的改写**，不是独立作品。
句级比对只能证明"没有逐字复制"，不能证明"独立创作"。

### 为什么是做法 2

`scripts/` 下的代码有两种来源，都自带明确的法律地位：

| 文件                                                                 | 来源                | 法律地位                          |
| -------------------------------------------------------------------- | ------------------- | --------------------------------- |
| `document.py` / `utilities.py` / `templates/`                        | appautomator（MIT） | MIT 允许派生，保留声明即可        |
| `postcheck*.py` / `fix_footer_fields.py` / `add_toc_placeholders.py` | 本仓库原创          | 著作权归 ZCodium Exp.，可自由许可 |

以这些代码为事实源写文档，**引用链完全不经过原版文档**，与做法 1 是不同性质的操作。
附带收益是文档与实现必然一致——我们已知实现与原版存在实质差异（`updateFields` 插入位置、
CT_Settings 子元素顺序），描述原版的文档反而会误导使用者。

## 范围

### 纳入

`documents-plugin` 的文档层，全部由代码面派生：

| 产物                     | 派生来源                                                 |
| ------------------------ | -------------------------------------------------------- |
| `skills/docx/SKILL.md`   | `Document` 类 + `XMLEditor` 公开方法 + 三个补充脚本      |
| `agents/visual-judge.md` | 视觉评审职责；输出协议与同仓库其它 visual-judge 实现对齐 |

### 排除

- `references/` `routes/` `scenes/` `env_setup/` `setup.sh`（原版约 6000 行）：
  注册契约只要求 `SKILL.md` 与 `visual-judge.md`，其余是质量项，另立 A1b。
- `document.py` 的拆分（A2）：该文件是 MIT 派生，无需 clean-room，独立推进。
- 代码行为变更：本规格只新增文档，不改任何脚本行为。

## 事实源：现有公开接口

文档必须只描述下列已存在的接口，不得描述代码里没有的能力。

`utilities.py` → `XMLEditor`：`get_node`、`replace_node`、`insert_after`、
`insert_before`、`append_to`、`get_next_rid`、`save`

`utilities.py` 的 `set_content_handler` **不是类方法**：它是
`_create_line_tracking_parser()`（`utilities.py:343`）内部的闭包，通过
`parser.setContentHandler = set_content_handler` 挂在解析器实例上，用途是行号跟踪。
文档不得把它描述成 `XMLEditor` 的公开方法。

`document.py` → `Document`：`__init__`、`__getitem__(xml_path)`（返回 `DocxXMLEditor`）、
`add_comment(start, end, text)`、`reply_to_comment(...)`、`validate()`、
`save(destination, validate)`

`document.py` → 模块级：`_strip_formatting_whitespace`、`_pack_document`、
`_generate_hex_id`、`_generate_rsid`、`_insert_settings_element`

三个补充脚本（本仓库原创，命令行入口）：`postcheck.py`（11 条规则）、
`fix_footer_fields.py`、`add_toc_placeholders.py`

## 状态所有者与契约

- **文档的唯一事实源是实现代码**，不是原版插件、不是官方文档、不是记忆。
- 实现变更时必须同步文档；文档声称的能力在代码里找不到，即为缺陷。
- `SKILL.md` 描述的是 Agent 的使用方式（何时用哪个脚本/方法、参数、失败语义），
  不是 Python API 手册。
- `visual-judge.md` 是只读评审 agent：判定渲染产物的视觉质量，不修改文档；
  每页输出一行 JSON 裁决。

### 执行者边界

- **不得读取官方安装包内容作为写法参考。** 安装包仅用于验收场景 2 的比对，
  且由验证方读取，执行者不读。
- **不得把仓库内任何未经独立验证的文件当作「结构参照」。** 结构参照只能取自
  本仓库已确认原创的文件，或直接取自宿主格式约定
  （`skill-creator-plugin/skills/skill-creator/SKILL.md` 的格式章节）。

## 原版材料的位置（验收场景 2 的前提）

官方安装包以未跟踪文件形式存在于仓库根：`ZCode-3.14.1-linux-x64.deb`、
`ZCode-3.14.1-mac-arm64.dmg`。deb 内原版插件位于
`./opt/ZCode/resources/glm/packages/<plugin>/`，取出方式：

```bash
ar x ZCode-3.14.1-linux-x64.deb          # 得 data.tar.xz
xz -dc data.tar.xz | tar xf - -C <dir> ./opt/ZCode/resources/glm/packages/<plugin>/<path>
```

这些文件**不得提交，也不得作为写法参考阅读**；只在执行验收场景 2 的比对时读取。
找不到原版时不得用代理材料替代比对并据此宣称结论——代理比对无效。

## 附带修复：numbering-continuity 是死规则

写文档层时逐条核对 `postcheck` 的 11 条规则，发现
`postcheck_document.py:150` 的编号列表 ID 收集有缺陷：

```python
# 修复前：w:numPr 没有 w:numId 属性，.get() 永远返回 None
context.numbering_ids = {
    num.get(f"{W}numId") for num in root.iter(f"{W}numPr") if num.get(f"{W}numId")
}
```

OOXML 中 numId 是 `w:numPr` 的**子元素**：

```xml
<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
```

后果：`numbering_ids` 恒为空集，`check_numbering_continuity`
恒返回 `"no numbered lists"` 并判 PASS。该规则对任何输入都不生效。
同一文件 `postcheck_document.py:181` 读 `w:pStyle` 用的是正确的
`.find(f"{W}pStyle")`，因此这是笔误而非设计。

修复为读子元素属性。行为变化：此前带编号列表的文档一律免费通过，
修复后该规则开始真正参与判定。

## 验收场景

1. `skills/docx/SKILL.md` 与 `agents/visual-judge.md` 存在，可被 seed 契约校验通过。
2. **非复制证明**：把 Markdown 的硬折行展开后按句切分，与原版对应文件做句级 diff，
   相同句比例为 0。这是可验证的下界，不是法律结论。
3. **能力对齐**：SKILL.md 提到的每个脚本/方法都能在上面「事实源」清单里找到；
   反向地，清单里的公开接口都在 SKILL.md 里有对应说明。
4. `postcheck.py` 能在 SKILL.md 描述的工作流上跑通（11 条规则不误报）。
5. 不引入 `node_modules`、`__pycache__`、`*.pyc`。
6. `pnpm typecheck`、`pnpm lint` 保持基线。
7. **numbering 修复回归**：含编号列表的文档上，`numbering-continuity`
   不再返回 `no numbered lists`；其余 10 条规则结论不变。

### 关于验收场景 2 的可行下界

句重合为 0 是**可验证的下界**，不是法律结论。技术文档中有一类重合无法也不应消除：
CLI 命令、flag 名、环境变量名、配置键名、类型与字段名、i18n 界面文案、
源码里本就存在的 API 签名。改变它们会使文档变错。判定时分清两类：
**功能令牌允许重合，表达性散文与代码示例必须为 0。**

## 非目标

- 不重新许可任何文件，不做许可边界清单（该议题已单独搁置）。
- 不补 `references/` 等剩余约 6000 行文档层（A1b）。
- 不动 `document.py` 的 1356 行拆分（A2）。
- 不追求与原版文档层的结构相似；结构由我们的代码形状决定。
- 不重写 `postcheck` 其他规则的判定逻辑；本次只修这一处已实证的缺陷。
