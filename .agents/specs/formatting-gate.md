# 格式门禁（Formatting Gate）

本 spec 记录 `pnpm fmt:check` 作为 CI 门禁的规则、忽略清单的维护方式，以及为什么加入它。

## 范围与产品规则

- 格式化器：`oxfmt`（配置在 `.oxfmtrc.json`，版本以 `package.json` 的 `devDependencies.oxfmt` 为准）
- 门禁位置：`.github/workflows/desktop.yml` 的 `checks` job，排在 `Lint` 之后、`Architecture` 之前
- 写入者：本仓库源码由贡献者本地执行 `pnpm fmt`（= `oxfmt`，不带 `--check`）落盘；CI 只校验不改写

**没有门禁的格式化必然复发。** 门禁之前的状态是：79 个文件不通过，其中 43 个是本仓库自己写的，且每个手写 PR 都会再添几个。所以「格式化」与「门禁」必须同时落地——只格式化不加门禁等于一次性美化。

## 忽略清单的三类

`.oxfmtrc.json` 的 `ignorePatterns` 只允许三类条目：

### 1. 生成物（不得格式化）

生成物由脚本落盘，格式化会在下次生成时被覆盖，属无效改动。已收录：

| 条目                                                                                                                                           | 生成者                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                                                                                                                                 | `@release-it/conventional-changelog`（writer opts 见 `scripts/release-it/changelog-writer.mjs`） |
| `THIRD-PARTY-NOTICES.md`                                                                                                                       | 三方声明生成流程                                                                                 |
| `third-party/inventory.json`                                                                                                                   | 同上                                                                                             |
| `third-party/upstream/**`、`third-party/native-search/licenses/**`、`third-party/runtime/*.txt`                                                | 上游/第三方原样收录                                                                              |
| `packages/desktop/src/renderer/src/plugin-sandbox/genUiTweakRuntime.js`、`apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/**` | 产物式资源                                                                                       |

### 2. 与上游逐字节对齐的文件（保持不格式化）

本仓库是 `zai-org/ZCode` 的 fork，同步上游靠 scoped diff（见 `upstream-sync-3.15.1.md`）。**若格式化上游继承来的文件，它们会永久偏离上游**，每次上游改动都要在 diff 里手工过滤格式化噪声。

因此这批文件**显式逐条列出**在 `ignorePatterns` 中，不格式化：

- 判定口径：该文件存在于上游 `29628c9`（v3.14.3）的树中，且在上游 `aac47556`（v3.15.1）前后仍不满足 oxfmt
- 当时共 36 条，集中在 `packages/services/src/bots/**`（18）、`packages/ui/src/**` 的 bots/CUA 相关文件（12），以及 `knip.json`、`packages/zcode-cua/package.json` 等零散项

**不使用目录 glob。** `packages/services/src/bots/**` 这类目录仍在活跃开发，glob 会把未来的自有文件一并排除在格式之外；显式清单只钉住已知的上游继承文件。

### 3. 内联产物

见上表最后一行；与本 spec 同属「生成后落盘」。

## 维护规则

1. **新增排除项必须在 PR 里写明理由**，且只能归入上三类之一。不得为「让门禁变绿」而排除自有源码。
2. **自有源码不排除。** 本仓库自己写的文件一律格式化。
3. **上游对齐类条目可以移除**，条件是：该文件已不再需要与上游逐字节对比（例如对应的上游能力已被本仓库重写取代，如 CUA 运行时），或该文件已被上游删除。
4. 上游新版本进来后，若上游文件不满足 oxfmt，按第 2 类追加条目，并在同步 spec 里记一笔。

## 格式化器与 `max-lines` 的交互

`oxfmt` 会拆长行，因此**格式化会增加行数**，与 `max-lines: 400` 直接冲突：

| 文件                                       | 格式化前 | 格式化后 |
| ------------------------------------------ | -------: | -------: |
| `packages/zcode-cua/test/surface.test.mjs` |      277 |  **477** |

`.oxlintrc.json` 的豁免原本只写了 `**/*.test.ts` / `.tsx` / `.spec.ts` / `.tsx`，**漏了 `.mjs`**。而 `scripts/ci/`、`scripts/tests/` 与 `packages/*/test/` 下的测试全都是 `.mjs`，因此这批测试从未被豁免过——只是原先靠「一行塞多条语句」压在 400 行以内才没暴露。已补上 `.mjs` / `.js`。

**规则：提交前必须同时跑 `fmt:check` 与 `lint`。** 只跑一个会把冲突推迟到 CI：格式化可能让文件越过 400 行上限，而为了压行数又会让 `fmt:check` 变红。

## 本次落地内容（基线证据）

| 项                      | 数值                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 门禁前 `fmt:check` 失败 | 79 个文件（43 个自有 + 36 个上游继承）                                                                                                          |
| 另有的误报              | 1132 个，全部来自 `apps/zcode-cli-rust/target`（oxfmt 不读 `.git/info/exclude`），已由 `ignorePatterns` 的 `apps/zcode-cli-rust/target/**` 修掉 |
| 本次格式化              | 42 个自有文件（`+1088 / -488`），纯排版、零语义改动                                                                                             |
| 顺带修掉                | `.oxlintrc.json` 的 test/spec 豁免漏了 `.mjs` / `.js`（见上节）                                                                                 |
| 门禁后 `fmt:check`      | 全部通过（3113 个文件）                                                                                                                         |

格式化前后测试结果不变，作为「纯排版」的证据：

- `scripts/ci/*.test.mjs`：263 passed / 0 failed（前后一致）
- `packages/zcode-cua/test/*.test.mjs`：158 passed / 0 failed
- `packages/zcode-cua/compatible/helper/gnome-extension/metadata.json` 仍为合法 JSON

## 验收场景

1. `pnpm fmt:check` 在干净检出上必须通过；失败即 CI 红。
2. 新增自有源码未格式化时，`checks` job 的 `Format` 步骤必须失败——不得通过放宽 `ignorePatterns` 规避。
3. 上游对齐类条目的增删必须在 commit 里可追溯（理由写在提交信息或本 spec）。
4. 修改生成物的格式化规则时，必须同步修改生成器，不得只改 `ignorePatterns`。
