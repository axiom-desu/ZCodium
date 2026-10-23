import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";

import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";

// 拆分只允许移动对象字面量；id、顺序、appVersion 与 sql 原字节必须保持不变。
// Rust contract assets 的 --check 以这些 SQL 与 node/migrations/*.sql 逐字节比较。
const EXPECTED = [
  [
    "0001_base_session_store",
    "0.2.0",
    "3b3d7c1a4c9de1cb01ead86f70f6d69b973de7bb306b3159c228f604f1afeb9f",
  ],
  [
    "0002_local_setting",
    "0.2.0",
    "8d47d7768ceec46ec62398960171c8f5b1ddd9692b9702a90616a5a20eccb3ae",
  ],
  [
    "0003_backfill_permission_local_setting",
    "0.2.0",
    "5bf14148baaf0c5b103debdde344a915382c1eab774418a42275c54ea55952e0",
  ],
  [
    "0004_session_target",
    "0.7.0",
    "21bdd3f784813ad064ab39b1093a7966f333c81e80142a4f0f892c44ab3a7615",
  ],
  [
    "0005_session_target_accounting",
    "0.7.0",
    "e042c214123d2c3eb2e312e96a2ce1909249310d16583b99f69fd07afc7532e3",
  ],
  [
    "0006_input_history_attachments",
    "0.11.0",
    "dfe81fe542b0fd21d9edf7e8cbedf82edd3a3b2b8d96a8bb8d231002c1354c85",
  ],
  [
    "0007_workflow_script_runtime",
    "0.13.0",
    "fb5331374fbb40860e062d55d193ccf31ee2fb4aa07bcc1201980c97e70be2f2",
  ],
  [
    "0008_workflow_definition_scope",
    "0.13.0",
    "f1945dd58b0a41650a872592e544fa470186a7b3a7ec66b04ce637d9e86268d5",
  ],
  [
    "0009_session_title_metadata",
    "0.14.0",
    "ffcc035e6436eeb518af8b83cfd1f0fa9c6e7cc5ecd74cd89ecae7a1ec0fcdbd",
  ],
  [
    "0010_usage_observability",
    "0.15.0",
    "1588b4532feb48c96ba85bdcb5248fe2f7ea161c43c0623162137b8d320aaf43",
  ],
  [
    "0011_session_target_summary_title",
    "0.15.0",
    "4171f5977e4b69f37bc78ae1d1b2ed2074c24251449aa48ed0aaa0cafae8064a",
  ],
  [
    "0012_session_trace_id",
    "0.15.0",
    "e6159dcfa86a75b435a7a007d3a4a75a1a6981c20711ff37664543425f114033",
  ],
  [
    "0013_session_target_active_run_accounting",
    "0.15.0",
    "30316c7760e3a6f1ea25817d34a58600d362ffef2831a7dd5d1a5eb3e76f35f8",
  ],
  [
    "0014_message_part_sequence",
    "0.15.0",
    "bfcf070c7e49cad417bf727fb0e3690a59bd9c47c56fbfa3363be63ec3b3f7a1",
  ],
  [
    "0015_message_part_sequence_backfill_and_guard",
    "0.15.2",
    "2e96d96ccc8d4ec76dccf6d10e0e468eb1b613253236628549855dfd9a182988",
  ],
  [
    "0016_session_input_ledger",
    "0.15.2",
    "6af25556e75c40fa3882ff43fd2b249f78ec8ef8716138b50348530c225fe9c2",
  ],
  [
    "0017_session_input_start_now_delivery",
    "0.15.2",
    "1d8143818cb355518ea81ec3e0042d37218a06171395117d7441c4a2265a5308",
  ],
  [
    "0018_session_input_failed_status",
    "0.15.2",
    "701aeb636ac599143133fe22c68313b95c44bd89ada831985e9471754b35b243",
  ],
  [
    "0019_dwf_journal",
    "0.16.5",
    "ea83ae2ec1627032b8e38989d5ddad1c10113d39462361caaf60da9601417d95",
  ],
  [
    "0020_provider_model_selection",
    "0.16.5",
    "5eaa060f38e07f3a14d9d0232e878623664ddccf912d7ac448bbcd8bf97305b6",
  ],
  [
    "0021_official_glm_selection",
    "0.16.5",
    "d6138e91287eb6e07472b907b3eb92d89230fef6bc901efac5bf278365119a6d",
  ],
  [
    "0022_backfilled_session_reasoning",
    "0.16.5",
    "ea8aeebb6611bdd90dc70069b4002053dc63fd44b834bd4c961bcb17f38850a3",
  ],
  // 仅 0023 尚未在本分支发布，其 sql 尾部规范化（trimEnd 后补单个换行）后原字节改变，
  // 故此处锁的是新字节；账本 checksum 走 trim 计算，仍为 999cc984… 不变，兼容已写库。
  [
    "0023_session_soft_delete_outcome",
    "0.16.9",
    "8d7bd83cd3f3c7359af4d3261d878f76fdb1de80f8b99a060729082a13f601cd",
  ],
] as const;

it("migration ledger keeps id order, appVersion and exact SQL bytes", () => {
  assert.equal(SQLITE_MIGRATIONS.length, EXPECTED.length);
  for (const [index, migration] of SQLITE_MIGRATIONS.entries()) {
    const [id, appVersion, sha256] = EXPECTED[index]!;
    assert.equal(migration.id, id);
    assert.equal(migration.appVersion, appVersion);
    assert.equal(createHash("sha256").update(migration.sql, "utf8").digest("hex"), sha256);
  }
});
