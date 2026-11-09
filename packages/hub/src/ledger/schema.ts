/**
 * 账本表结构（design D2）。
 *
 * - `events`：只追加。用触发器禁止 UPDATE / DELETE，保证已写入的事件不可修改。
 * - 投影表：`tasks`、`nodes`、`leases`、`schedule_fires`、`replies`、`inbox_items`、`channel_messages`，全部由 `apply(event)` 维护，
 *   可随时清空后按 seq 重放得到（`rebuild()`）。
 * - 软状态列（不由事件派生，重建时按 D2 重置，见 `SOFT_COLUMNS`）：
 *   `tasks.last_activity_at`、`tasks.activity_json`、`nodes.last_seen_at`、`leases.expires_at`。
 */

export const PROJECTION_TABLES = [
  'tasks',
  'task_prs',
  'nodes',
  'leases',
  'schedule_fires',
  'replies',
  'inbox_items',
  'channel_messages',
  'pr_subscriptions',
  'pr_cursors',
  'task_inputs',
] as const
export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

/** 每张投影表的软状态列；比较"增量投影 == 重建投影"时排除。 */
export const SOFT_COLUMNS: Readonly<Record<ProjectionTable, readonly string[]>> = {
  tasks: ['last_activity_at', 'activity_json'],
  task_prs: [],
  nodes: ['last_seen_at'],
  leases: ['expires_at'],
  schedule_fires: [],
  replies: [],
  inbox_items: [],
  channel_messages: [],
  pr_subscriptions: [],
  pr_cursors: [],
  task_inputs: [],
}

/** 每张投影表的主键（快照排序用）。 */
export const PROJECTION_KEYS: Readonly<Record<ProjectionTable, string>> = {
  tasks: 'id',
  task_prs: 'task_id, pr',
  nodes: 'node_id',
  leases: 'lease_id',
  schedule_fires: 'rule_id, planned_at',
  replies: 'id',
  inbox_items: 'id',
  channel_messages: 'channel, ref, item_id',
  pr_subscriptions: 'subscribed_seq',
  pr_cursors: 'workspace, pr, kind',
  task_inputs: 'seq',
}

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  workspace    TEXT,
  task_id      TEXT,
  actor        TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS events_task_type ON events (task_id, type, seq);
CREATE INDEX IF NOT EXISTS events_workspace ON events (workspace, seq);
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, ts);
-- 高频派工核对仅查询对应 attempt / lease，避免读取任务的全部历史事件。
CREATE INDEX IF NOT EXISTS events_attempt_ended ON events
  (task_id, json_extract(payload_json, '$.attempt'), seq)
  WHERE type = 'task.attempt_ended';
CREATE INDEX IF NOT EXISTS events_worker_report ON events
  (task_id, json_extract(payload_json, '$.lease_id'), json_extract(payload_json, '$.attempt'), seq, ts)
  WHERE type = 'task.reported';
CREATE INDEX IF NOT EXISTS events_worker_report_consumed ON events
  (task_id, json_extract(payload_json, '$.lease_id'), json_extract(payload_json, '$.attempt'),
   json_extract(payload_json, '$.report_seq'), seq)
  WHERE type = 'task.report_consumed';
CREATE INDEX IF NOT EXISTS events_worker_report_conflict ON events
  (task_id, json_extract(payload_json, '$.lease_id'), json_extract(payload_json, '$.attempt'),
   json_extract(payload_json, '$.report_seq'))
  WHERE type = 'task.report_conflict';
-- pr-watcher 每次轮询的同一秒去重查询（harness-neutral 8.3）：只索引 pr.event。
CREATE INDEX IF NOT EXISTS events_pr_cursor ON events
  (workspace, json_extract(payload_json, '$.pr'), json_extract(payload_json, '$.kind'),
   json_extract(payload_json, '$.cursor'))
  WHERE type = 'pr.event';
CREATE INDEX IF NOT EXISTS events_pr_dispatched ON events
  (json_extract(payload_json, '$.pr_event_seq'))
  WHERE type = 'pr.dispatched';
CREATE INDEX IF NOT EXISTS events_task_reply ON events
  (task_id, json_extract(payload_json, '$.reply_id'), seq)
  WHERE type = 'task.replied';
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  workspace        TEXT NOT NULL,
  status           TEXT NOT NULL,
  contract_json    TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE,
  parent           TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  created_seq      INTEGER NOT NULL,
  last_seq         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  blocked_json     TEXT,
  result_json      TEXT,
  created_by       TEXT NOT NULL,
  last_activity_at TEXT,
  activity_json    TEXT NOT NULL DEFAULT '[]',
  resume_json      TEXT,
  origin           TEXT,
  mandate_json     TEXT,
  branch           TEXT,
  worktree         TEXT,
  repo_snapshot_json TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, created_seq);
CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks (workspace, created_seq);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent, created_seq);

CREATE TABLE IF NOT EXISTS task_prs (
  task_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  pr TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  summary_chars INTEGER NOT NULL,
  PRIMARY KEY (task_id, pr)
);
CREATE INDEX IF NOT EXISTS task_prs_workspace_pr ON task_prs (workspace, pr, task_id);
CREATE INDEX IF NOT EXISTS task_prs_pr ON task_prs (pr, workspace, task_id);
CREATE INDEX IF NOT EXISTS task_prs_workspace_number ON task_prs (workspace, pr_number, task_id);

CREATE TABLE IF NOT EXISTS nodes (
  node_id           TEXT PRIMARY KEY,
  hostname          TEXT NOT NULL,
  version           TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  executors_json    TEXT NOT NULL,
  concurrency       INTEGER NOT NULL,
  registered_at     TEXT NOT NULL,
  last_seen_at      TEXT,
  isolation_probe_json TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  token_sha256 TEXT NOT NULL,
  ttl_s        INTEGER NOT NULL,
  granted_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired')),
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS leases_task ON leases (task_id, state);
CREATE INDEX IF NOT EXISTS leases_active ON leases (state, expires_at);

CREATE TABLE IF NOT EXISTS schedule_fires (
  rule_id      TEXT NOT NULL,
  planned_at   TEXT NOT NULL,
  workspace    TEXT NOT NULL,
  fired_at     TEXT NOT NULL,
  missed       INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  PRIMARY KEY (rule_id, planned_at)
);

CREATE TABLE IF NOT EXISTS replies (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'approve', 'deny')),
  text         TEXT,
  by           TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_seq  INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'requeued', 'dropped')),
  delivered_at TEXT,
  fetched_at   TEXT
);
CREATE INDEX IF NOT EXISTS replies_task ON replies (task_id, state, created_seq);

-- 收件箱条目（add-m1-inbox D1）。id 由来源确定性生成（blk.<seq>、prop.<id>、pol.<seq>），
-- 同一来源只有一个条目；short_id 来源于 created_seq（base36），不单独存储。
-- deferred_until（3.3 静默顺延）、pushed_at 与 channel_refs_json（4.1 渠道消息引用）先预留，
-- 由后续的 inbox.item_updated / inbox.pushed 维护，同样只由事件派生。
CREATE TABLE IF NOT EXISTS inbox_items (
  id                TEXT PRIMARY KEY,
  level             TEXT NOT NULL CHECK (level IN ('interrupt', 'decide', 'digest')),
  source            TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  source_seq        INTEGER,
  reason            TEXT,
  workspace         TEXT,
  task_id           TEXT,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  actions_json      TEXT NOT NULL,
  options_json      TEXT,
  state             TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_seq       INTEGER NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_seq          INTEGER NOT NULL,
  deferred_until    TEXT,
  pushed_at         TEXT,
  channel_refs_json TEXT NOT NULL DEFAULT '[]',
  close_reason      TEXT,
  close_note        TEXT,
  closed_at         TEXT,
  closed_by         TEXT,
  closed_seq        INTEGER,
  cause_seq         INTEGER,
  cause_actor       TEXT,
  closed_via        TEXT
);
CREATE INDEX IF NOT EXISTS inbox_open ON inbox_items (state, level, created_seq);
CREATE INDEX IF NOT EXISTS inbox_task ON inbox_items (task_id, state);
CREATE INDEX IF NOT EXISTS inbox_source ON inbox_items (source, state);

-- 渠道消息与条目的对应（add-m1-inbox D4 的 channel_messages；由 inbox.pushed 派生）：
-- 渠道把用户对某条消息的回复映射回条目，条目关闭后据此找到要改为"已处理"的消息。
-- 发送失败（op=failed、没有 ref）的条目记一行 ref = ''，failed_* 有值，视为已处理、不再推送；
-- "已处理"同步失败时在原消息行上记 failed_*，synced_at 取放弃的时间。
CREATE TABLE IF NOT EXISTS channel_messages (
  channel       TEXT NOT NULL,
  ref           TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  sent_seq      INTEGER NOT NULL,
  synced_at     TEXT,
  failed_at     TEXT,
  failed_reason TEXT,
  PRIMARY KEY (channel, ref, item_id)
);
CREATE INDEX IF NOT EXISTS channel_messages_item ON channel_messages (item_id);
CREATE INDEX IF NOT EXISTS channel_messages_sync ON channel_messages (channel, synced_at);

-- PR 订阅（harness-neutral D11；由 pr.subscribed / pr.unsubscribed 派生）。同一任务对同一 PR
-- 同时只有一条 active 订阅；结束后保留记录，task show 一并显示。
CREATE TABLE IF NOT EXISTS pr_subscriptions (
  subscribed_seq INTEGER PRIMARY KEY,
  task_id        TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  pr             TEXT NOT NULL,
  role           TEXT NOT NULL,
  subscribed_at  TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  ended_at       TEXT,
  ended_seq      INTEGER,
  reason         TEXT
);
CREATE INDEX IF NOT EXISTS pr_subscriptions_task ON pr_subscriptions (task_id, pr, state);
CREATE INDEX IF NOT EXISTS pr_subscriptions_active ON pr_subscriptions (state, workspace, pr);

-- PR 事件的读取游标（由 pr.event 派生）：每个 workspace、PR 与种类保留已入账的最大游标，
-- 中枢重启后从这里续读，已入账的事件不再送达。
CREATE TABLE IF NOT EXISTS pr_cursors (
  workspace TEXT NOT NULL,
  pr        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  cursor    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  PRIMARY KEY (workspace, pr, kind)
);

-- 任务输入（harness-neutral 8.4；由 task.input_added / task.input_delivered / task.started 派生）：
-- pending 待送达；running 已送进运行中的 worker；dispatch 随某次派工的输入下发。
CREATE TABLE IF NOT EXISTS task_inputs (
  seq          INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  pr_event_seq INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'running', 'dispatch')),
  delivered_at TEXT,
  lease_id     TEXT
);
CREATE INDEX IF NOT EXISTS task_inputs_task ON task_inputs (task_id, state, seq);
CREATE INDEX IF NOT EXISTS task_inputs_event ON task_inputs (task_id, pr_event_seq);
`

/**
 * 旧版本账本缺少的列（`CREATE TABLE IF NOT EXISTS` 不会补列）。打开账本时逐一补上；
 * 这些列都由事件派生，补列后旧事件中本来就没有对应信息，取 NULL 与重建结果一致。
 */
export const LEDGER_COLUMN_MIGRATIONS: ReadonlyArray<{
  table: ProjectionTable
  column: string
  ddl: string
}> = [
  { table: 'replies', column: 'fetched_at', ddl: 'ALTER TABLE replies ADD COLUMN fetched_at TEXT' },
  { table: 'tasks', column: 'resume_json', ddl: 'ALTER TABLE tasks ADD COLUMN resume_json TEXT' },
  // add-m1-supervisor：task.created 的 origin（D2）与 task.branch_reported 的分支（D15）。
  { table: 'tasks', column: 'origin', ddl: 'ALTER TABLE tasks ADD COLUMN origin TEXT' },
  { table: 'tasks', column: 'mandate_json', ddl: 'ALTER TABLE tasks ADD COLUMN mandate_json TEXT' },
  { table: 'tasks', column: 'branch', ddl: 'ALTER TABLE tasks ADD COLUMN branch TEXT' },
  // add-m1-supervisor 5.6：task.branch_reported 一并上报的任务 worktree。
  { table: 'tasks', column: 'worktree', ddl: 'ALTER TABLE tasks ADD COLUMN worktree TEXT' },
  {
    table: 'tasks',
    column: 'repo_snapshot_json',
    ddl: 'ALTER TABLE tasks ADD COLUMN repo_snapshot_json TEXT',
  },
  // worker-credential-isolation 3.2：节点注册上报的最近一次隔离探针结果。
  {
    table: 'nodes',
    column: 'isolation_probe_json',
    ddl: 'ALTER TABLE nodes ADD COLUMN isolation_probe_json TEXT',
  },
  // add-m1-supervisor：supervisor 提问的选项（D11）。
  {
    table: 'inbox_items',
    column: 'options_json',
    ddl: 'ALTER TABLE inbox_items ADD COLUMN options_json TEXT',
  },
]
