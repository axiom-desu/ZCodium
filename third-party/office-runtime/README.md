# office-runtime 许可标识登记与材料

本目录只登记 office-runtime 构建依赖闭包里**非绿色**的三项，以及校验它们所需的
原始材料。`node scripts/licenses.mjs check` 的标识阶段扫描全实装集（prod+dev），
因此这些 build-only devDependency 与仅安装子树也必须通过标识门禁；这不是许可豁免，
不扩展 GREEN 正则，不新增宽泛 allowlist，也不关闭 `third-party/inventory.json`
既有 16 项 `reviewRequired`。

校验实现见 `scripts/license-identifiers.mjs`（精确三元组 + 材料哈希 + 已安装字节），
正/负例见 `scripts/ci/office-license-identifiers.test.mjs`。原始材料逐字节存放在已有的
`third-party/upstream/office-runtime/` 材料边界下（`.gitattributes` 的
`third-party/upstream/** -text -whitespace` 已按字节保护），禁止格式化或改写；代码/JSON/CSS
类快照加 `.txt` 后缀，避免 lint、格式化和依赖扫描把证据当成源码。

## 登记项

| 包                               | 标识      | 范围                              | 证据                                                                                                              |
| -------------------------------- | --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@fontsource/noto-sans-sc@5.3.1` | `OFL-1.1` | build-only，随插件原样分发        | `noto-sans-sc-5.3.1-LICENSE.txt`、`noto-sans-sc-5.3.1-400.css.txt`、`noto-sans-sc-5.3.1-slices-400.json.txt`      |
| `buffers@0.1.1`                  | `MIT/X11` | 仅安装（archiver 子树，不进产物） | `buffers-0.1.1-package.json.txt`（发布方固定提交补登）、`buffers-0.1.1-index.js.txt`（与 npm 发布代码逐字节一致） |
| `chainsaw@0.1.0`                 | `MIT/X11` | 仅安装（archiver 子树，不进产物） | `chainsaw-0.1.0-package.json.txt`（npm 发布元数据）、`chainsaw-0.1.0-index.js.txt`                                |

## 字体（OFL-1.1）

- 来源：`https://registry.npmjs.org/@fontsource/noto-sans-sc/-/noto-sans-sc-5.3.1.tgz`，
  registry integrity `sha512-YxZ/VWAWo9FWzH08Q6fGTzIW6vYNP2TMhUFCnfhlimbhdXnWrxJLrzX3KWt2FKnV0s8XiM5vjpGHQiyFRlTj0w==`，
  tarball sha256 `fd4c218cad77f6f1e9915c45e5d2ede5b0c86dfa0658739684791f50956d1cae`（1,905 文件 / 74,648,760 B）。
- `LICENSE` 4,314 B，sha256 `18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3`，
  版权行 `Google Inc.`，正文为 SIL OFL 1.1（2007-02-26）；包内未声明 Reserved Font Name。
- `400.css` sha256 `cd474dcebdf85aa5d537882894217907fcc7db2b990c4e54ef1b924521596260`；
  97 个 `noto-sans-sc-<n>-400-normal.woff2` 分片合计 2,382,648 B，
  逐文件 `sha256 + "  " + 文件名` 排序后（含结尾换行）的绑定哈希为
  `1f4fde6b2546a2a23a956f8e39152db85de8745d62c1526fb72d1e5afe74dbc7`。
- 义务：分片按原字节复制，不改名、不子集化、不改字体内部名称；插件产物随附完整
  OFL-1.1 原文与版权行；不得单独销售字体。字体只作为 office-runtime 的
  build-only devDependency 与插件资源分发，不进入 `packages/ui` 生产依赖或根 PDF peer。

## buffers（发布包缺许可字段）

npm 发布包没有 `license` 字段，也没有 LICENSE 文件。发布方在固定提交
`bitpay/node-buffers@1b745ee35d33eb166e15ef1866073a07c6d7de87` 为同一版本补登
`MIT/X11`：该提交 `package.json` sha256 `eb42a43d5b685e6de2f2f4a5e18a70255be72349def7eedf504b912dd908913e`，
`index.js` sha256 `97801e296ba5f3c32242f647e1daac5917e300367fed7935ab1e62f40adb1b8a`，
与 npm 发布代码逐字节一致。校验因此同时要求「已安装包仍无许可字段」且「已安装代码哈希
命中证据」；只说明识别依据，不编造缺失的许可全文。

## chainsaw（非 SPDX 拼写）

npm 发布 `chainsaw@0.1.0` 自带 `"license": "MIT/X11"`，元数据快照 sha256
`51910ad64abca4eb8c2c23abb2f713ba5220db89ed89c9fd198d27241a5a70ea`；发布代码
`index.js` sha256 `2fd46e18cf7cc2f90684023a951f0289c01316f4fb76cec197da14d0449106ba`。
上游仓库没有 LICENSE 文件、README 无许可段，因此只按精确发布元数据 + 代码证据登记，
不按 `MIT` 前缀泛化放行。

## 构建闭包内缺完整原文的三项（不参与标识放行）

`third-party/upstream/office-runtime/` 另存发布方固定 tag 原文，供 office-runtime
插件构建生成 `THIRD_PARTY_NOTICES.txt` 使用；它们本身是绿色标识，不改变标识门禁：

- `saxes-5.0.1-LICENSE.txt`：npm tarball 无 LICENSE，取 `lddubeau/saxes@v5.0.1`，
  3,011 B，sha256 `0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e`。
- `nodable-entities-3.1.0-LICENSE.txt`：包内 README 只有一行 `MIT`，取
  `nodable/val-parsers@v3.1.0`，1,064 B，sha256 `750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40`。
- `duke-sheets-wasm-0.1.21-LICENSE.txt`：npm 包只有 `license: MIT` 字段、无 LICENSE 文件，取
  `guseggert/duke-sheets@wasm-v0.1.21`，1,067 B，sha256
  `ebb2e920800c6353474e3e23d84f714ee8aaecd8f5a71851aa03594a4129d855`；npm tarball
  `sha512-YJpLUo/K7N9iGZv+A74D8o6XlT1VjMdlq9i/pIj/DwAO9/7jqppaV60VdL0TgJ0UzUlbhChWR+qQGNTmESINlw==`。

根 `THIRD-PARTY-NOTICES.md` 只覆盖生产依赖图，这些 build-only 依赖不会进入根 NOTICE；
它们的完整原文义务由插件产物内的通知承担。本目录记录输入哈希，不代表发布合规，
也不代表插件通知已生成或已通过验收。

## 刷新

仅使用公开 npm registry 与发布方固定 ref 重新取原始字节，先核对 tarball
`dist.integrity`/sha256，再更新 `scripts/license-identifiers.mjs` 的哈希与本文档，
最后运行 `node scripts/licenses.mjs notices`（刷新根声明输入）与
`node scripts/licenses.mjs check`。不得用相邻版本、README 片段或通用许可文本替代。
