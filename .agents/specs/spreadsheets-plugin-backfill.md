# spreadsheets-plugin 补全（Spreadsheets Plugin Backfill）

> [!WARNING]
> **历史快照，不反映当前实现。**
> 上游 3.15.1 同步已把这批插件换成上游版本（清单目录仍沿用本仓库的 `.zcodium-plugin`），本文描述的 backfill / clean-room 构建方式已不再是当前实现；其中的键级判定、许可排查与被排除基座等查证结论仍有参考价值。
> 取代背景与决策依据见 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)。

## 背景

RC-CHN 因 seed 契约不满足，把 `documents`、`pdf`、`spreadsheets` 从三处发行清单移除。
`documents` 与 `pdf`（Phase 1）已回到四处契约。`spreadsheets-plugin` 目录尚不存在。

### 与 pdf-plugin 的关键差异：这次有 MIT 基座

pdf-plugin 没有可依的开源基座，只能以公开 LaTeX 知识独立撰写。**spreadsheets 有**：
`appautomaton/document-SKILLs`（MIT，Copyright (c) 2026 appautomaton）提供
`xlsx/SKILL.md`（525 行）与 `xlsx/recalc.py`（186 行）。

MIT 是宽松许可，**允许派生并要求署名**。因此本插件不需要 clean-room 隔离，
也不需要"独立撰写"——按 documents-plugin 处理 `document.py` / `utilities.py` /
`templates/` 的同一路径即可：以 MIT 代码为基座派生，保留归属声明。

这比 pdf-plugin 的法律位置强得多：引用链明确落在 MIT 作品上，而非"参考专有实现后改写"。

## 范围

### Phase 1 — 可注册（本次范围）

| 产物                            | 来源                                    |
| ------------------------------- | --------------------------------------- |
| `package.json`                  | 契约字段，`license: Apache-2.0`         |
| `.zcodium-plugin/plugin.json`   | 契约字段，`name: spreadsheets`          |
| `NOTICE.md`                     | MIT 来源与许可边界声明                  |
| `skills/xlsx/scripts/recalc.py` | MIT 派生，保留署名                      |
| `skills/xlsx/SKILL.md`          | 由 MIT 基座适配，改写成 ZCode 技能形态  |
| `agents/visual-judge.md`        | 电子表格视觉评审，协议与 documents 对齐 |

完成后把 `spreadsheets` 加回四处契约。

### Phase 2 — 未纳入

- MIT `xlsx/SKILL.md` 中的 pandas 数据分析、图表、条件格式等章节可按需裁剪或保留，
  但必须通过署名与改写达到可维护状态，不是原样搬运。
- 深度功能（数据验证、透视表生成、VBA/宏）不在原版基座内，不做。

## 依赖现实（必须如实写入文档）

`recalc.py` 有两个外部依赖，都不能省略：

| 依赖                  | 用途               | 缺失时的行为                               |
| --------------------- | ------------------ | ------------------------------------------ |
| `openpyxl`            | 读取公式与扫描错误 | import 即失败                              |
| LibreOffice `soffice` | 真正重算公式       | `recalc()` 返回 `{'error': ...}`，不抛异常 |

因此 SKILL.md 必须写明：`openpyxl` 缺失时脚本不可用；`soffice` 缺失时重算步骤
返回错误而非崩溃。不得把重算写成无条件可用。

原版 `# /// script` 元数据声明 `requires-python = ">=3.12"`。实际代码不含 3.11+
语法特性，在本机 3.10.12 上可解析；派生版按真实可运行版本声明，并保留 openpyxl 依赖声明。

## 状态所有者与契约

- 四处契约清单见 `builtin-plugin-parity.md`；`spreadsheets` 加入后与 `documents` 同规则。
- `requiredSeedPaths` 必须包含 `skills/xlsx/scripts/recalc.py`——它是 SKILL.md
  「Recalculating formulas」章节描述的执行体，缺了就是"看得见技能、调不到脚本"。
- `visual-judge.md` 的输出协议（每页一行 JSON、`category` 枚举
  `Spec | Visual | Design | Unverified`）与 documents/presentations/pdf 版逐字一致。
- `LICENSE.txt` 不创建；`license` 字段为 `Apache-2.0`，MIT 来源在 `NOTICE.md` 声明。

## 验收场景

1. Phase 1 的 6 类文件存在；`pnpm typecheck`、`pnpm lint` 保持基线。
2. 四处契约均含 `spreadsheets`，staging 模拟通过（顶层白名单走一遍，
   全部必需路径可被 seed）。
3. **recalc.py 真实运行**：构造一个含公式的 .xlsx，跑 recalc，确认 JSON 输出
   含 `status`/`total_errors`/`total_formulas`；再构造一个含 `#REF!` 的文件，
   确认 `error_summary` 报出位置。这是行为验证，不是"看起来对"。
4. **协议一致性**：`visual-judge.md` frontmatter 键与顺序、JSON schema 键结构、
   `category` 枚举与 documents 版一致（用脚本比对）。
5. **署名完整**：`recalc.py` 保留 MIT 版权声明；`NOTICE.md` 说明派生来源。
6. SKILL.md 不引用任何不存在的脚本。
7. 不引入 `node_modules`、`__pycache__`、`*.pyc`。

## 非目标

- 不重写 MIT `xlsx/SKILL.md` 的全部 525 行为独立原创——MIT 允许派生，
  按派生处理并署名，与 documents-plugin 的 MIT 部分同规则。
- 不实现 Phase 2 的深度功能。
- 不改 documents / pdf / presentations 的任何内容。
