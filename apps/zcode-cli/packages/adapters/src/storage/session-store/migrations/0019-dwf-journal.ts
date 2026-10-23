import type { SqliteMigration } from "./types.js";

export const DWF_JOURNAL_MIGRATIONS: readonly SqliteMigration[] = [
  {
    appVersion: "0.16.5",
    id: "0019_dwf_journal",
    // dynamic-workflow 执行引擎的 durable journal。
    // legacy 的 workflow_* 表只是模板不是家：dwf_* 自成一套，与既有 workflow 机制彼此独立。
    //
    // 本条是 beta 前把开发期 0019–0030 十二条迁移**压成的单一基线**：四张表一次建齐、形状即
    // 0030 之后的终态。中间态（三次为放宽 CHECK 的整表重建、0028 的删列改名）只存在于
    // 内部预览库里，收敛办法是删掉四张 dwf_* 表并清掉 schema_migration 里的 dwf 记账行，
    // 下次启动由本条重建。beta 之后本条
    // 不可再改：runner 按 checksum 记账，历史迁移只能追加。
    //
    // 只为占住 0019 这个槽位，让
    // staging 后续迁移从 0020 起编号，功能分支合回时 ledger 不会撞号。四张表在功能落地前闲置无害。
    //
    // 几条刻意为之的设计：
    // 1) parent_session_id / session_id 是纯 text，不加 FOREIGN KEY——子代理会话跑在内存
    //    event store 上、没有 session 行，而 runner 开着 pragma foreign_keys = on，真加 FK
    //    会把合法的 journal 记录挡在门外。dwf_* 之外的任何表都不被引用，也不引用它们。
    // 2) dwf_run 没有节点上限 / token 预算列：run 级
    //    token 用量只作观察面，即 spent_tokens。
    // 3) dwf_node 的 unique(run_id, actor_id, actor_seq) 不可实现：putNode 是准入→结算→统计
    //    回填的 upsert，actor 坐标分散在三个可空列上；每子代理的 actor_seq 唯一性由引擎守。
    //    report / artifact 行有行无节点：一次写入、status 恒为 completed、actor 三列全空。
    // 4) 可空列一律「NULL 即缺席」：result_json / name / tool_call_id / args_json /
    //    resumed_from / resolved_model / message_boundary / artifact_id / input_json 都解码成
    //    缺席的键（args_json 解成 `{}`），不存哑值。
    // 5) 索引即查询形状（列序反了就只能全表扫）：
    //    - dwf_run_cwd_idx：按 cwd 枚举历史 run，「cwd 等值 + time_updated 倒序 + limit」。
    //    - dwf_node_artifact_idx：本 run 的产物行与按 id 取带标签的 report 行。
    //    - dwf_event_artifact_idx：看板取数按 journal sequence 分页，取数源是 dwf_event 而不是
    //      dwf_node；表达式索引（SQLite ≥ 3.9）让它不必扫整条 journal。第三列 sequence 不是
    //      装饰——没有它规划器宁可走 unique(run_id, sequence) 的自动索引再逐行筛产物。
    sql: `
      create table if not exists dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        args_json text,
        tool_call_id text,
        resumed_from text,
        caps_max_concurrency integer not null,
        spent_tokens integer not null default 0,
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);

      create table if not exists dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_actor_run_idx on dwf_actor(run_id);

      create table if not exists dwf_node (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        input_json text,
        status text not null check(status in ('running', 'completed', 'failed')),
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_node_run_idx on dwf_node(run_id);
      create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

      create table if not exists dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
    `,
  },
];
