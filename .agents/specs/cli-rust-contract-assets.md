# CLI Rust contract assets and paths

## 目标与真源

本适配让 `apps/zcode-cli-rust` 的路径默认值、配置 schema、工具/prompt 投影和 Node session-store migration 与本仓库当前 TS 契约一致。`packages/shared/src/appDirNames.ts` 是目录/文件命名唯一真源；CLI 配置以 `apps/zcode-cli/packages/adapters/src/config/schema.ts` 的 named exports 为准；工具及 prompt 以当前 CLI contracts/core exports 为准；session SQL 以 `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` 及其真实 migration 文件为准。上游脚本仅可作为实现参考，生成脚本必须引用本仓库路径和可解析的本仓库 exports。

## 路径、所有权与覆盖

Rust host/storage/config/trust/context/logging、root/runtime、domain/config、tools/plugins 等路径资产必须按实际 TS 调用层契约分别核对，不把独立 fallback 混为 CLI 默认。CLI `DefaultRuntimeConfig.storage`、`adapters/config/file-config.adapter.ts` 的 `DEFAULT_BASE_DIR` 与 truststore fallback 当前均为 `~/.zcodium`；`packages/shared` standaloneStore fallback 是 `~/.zcodium-exp`。Rust CLI effective config 默认必须与当前 `DefaultRuntimeConfig` 相等，不能用 `LEGACY` 常量冒充默认权威；日志/共享路径常量的新用户数据根仍为 `.zcodium-exp`。项目配置 `.zcodium`、插件清单目录 `.zcodium-plugin`。ZCODE_DATA_BASE_DIR、配置文件显式路径及其它现存 env/custom override 优先级不变。路径命名由共享纯 domain 常量提供，避免业务层重复字符串；允许由 `appDirNames.ts` 生成 Rust 常量并由 `--check` 校验。不得做真实用户目录读取、homedir 迁移或新增一次性复制逻辑；首次迁移仍待独立验收。发现 TS 默认之间不一致只记录为待统一主 spec 的事项，不修改 TS source 或新增迁移/拷贝策略。Rust root runtime 自有数据目录默认 `~/.zcodium-exp/rust`（new user-data root），与 CLI effective config storage 默认 `~/.zcodium` 是不同状态/路径所有者；前者的 Rust runtime fallback 不得被误记为 TS CLI config default。

## 生成契约

适配三个必要生成器：config schema、tool/prompt assets、Node projection schemas。生成目标限于 Rust domain/schema/config.json、node-projection.json、tools/tool_schemas 与 generator 当前实际提供的 prompt/tool json 资产。所有生成器须支持 `--check`，且 imports 均解析到本仓库现存 named exports；不能恢复已删除 TS 模块。TS 未提供的工具按 unsupported 处理，不凭上游数据补齐。

## Config 与独立 TS oracles

config oracle 必须从当前 CLI contracts `DefaultRuntimeConfig` 生成真实 defaults，再与 Rust 的 config merge/effective-config 用例共用；不得把 standaloneStore fallback 当成 CLI config default。workspace-hook snapshot/digest/review/grants 与 permission decision matrix fixtures 由本仓库 TS 行为重新执行生成，输入与 expected 都应体现本仓库当前 TS；上游 `../zcode-rs-upstream/scripts/zcode-cli-rust-{workspace-hook,permission}-fixtures.mjs` 仅提供纯生成逻辑参考，禁止简单替换 expected 或复制巨大旧 dependency tree。各生成器提供 `--check`，验证生成后无漂移。permission oracle 保持现行授权策略，路径差异不得成为放宽策略的理由。

## 已发现路径差异

TS CLI workspace config 用户路径为 `.zcodium`，Rust runtime fallback `home/.zcode/rust` 需要按 TS CLI 实际 runtime 行为核对；Rust net beta env 当前 `.zcode-beta`，TS `cli/env.ts` 为 `.zcodium-beta`，需同步并覆盖对应测试。pure tests 中 plugin manifest 用户路径 `.zcode-plugin` 跟随 TS；`.zcode-xx` 临时前缀、metadata namespace、canonical plugin id 属内部标识，不作为用户路径替换。所有路径测试以实际 TS oracle 为准。

## SQL 冻结与一致性

Rust state SQL 逐 migration id、statement bytes 对照 CLI `SQLITE_MIGRATIONS`（含 0020、0021、0022 源文件）并以 Node session-store 为唯一账本。历史 SQL/checksum 冻结，不为通过校验而修改旧 checksum，也不删除历史 DWF SQL；本适配不启用动态工作流。聚焦 check driver 复用现有 `syncNodeMigrations` 原流程并验证 ids/bytes 与 TS 一致。差异先记录、解释并按 TS 正确生成/校验，不能改写历史迁移掩盖差异。

## 验收

- Node 生成器运行后紧接 `--check`；Rust assets 可由 TS 真源重现。
- 对应 TS oracle focused tests、改动文件 oxfmt/oxlint、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 可用时只运行 Rust domain tests；Rust 整体测试待平台 executor 完成后统一验证。不得启动真实模型/runtime/DB；测试仅使用 tempdir/local fixture。
- 测试报告 schema 总数、已确认同步数、路径差分用例、脚本入口及最多四项待适配问题。
