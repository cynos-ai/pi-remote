-- V1 reference schema. S04 must install it through versioned migrations.
-- PRAGMA synchronous / busy_timeout are connection settings, not schema state.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  workspace_key TEXT NOT NULL,
  root_identity TEXT NOT NULL UNIQUE,
  git_common_dir TEXT,
  default_model_json TEXT CHECK(default_model_json IS NULL OR json_valid(default_model_json)),
  default_thinking_level TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  pi_session_id TEXT UNIQUE,
  pi_session_file TEXT UNIQUE,
  pi_persistence_state TEXT NOT NULL DEFAULT 'uninitialized'
    CHECK(pi_persistence_state IN ('uninitialized','unflushed','persisted')),
  history_error_code TEXT,
  model_json TEXT CHECK(model_json IS NULL OR json_valid(model_json)),
  thinking_level TEXT,
  queue_state TEXT NOT NULL DEFAULT 'ready' CHECK(queue_state IN ('ready','paused')),
  queue_version INTEGER NOT NULL DEFAULT 0 CHECK(queue_version >= 0),
  queue_pause_run_id TEXT,
  queue_pause_reason TEXT CHECK(queue_pause_reason IN ('failed','aborted','interrupted')),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
  live_state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(live_state_json)),
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK ((pi_persistence_state = 'uninitialized' AND pi_session_id IS NULL AND pi_session_file IS NULL)
    OR (pi_persistence_state IN ('unflushed','persisted') AND pi_session_id IS NOT NULL AND pi_session_file IS NOT NULL)),
  CHECK ((queue_state = 'ready' AND queue_pause_run_id IS NULL AND queue_pause_reason IS NULL)
    OR (queue_state = 'paused' AND queue_pause_run_id IS NOT NULL AND queue_pause_reason IS NOT NULL)),
  FOREIGN KEY(queue_pause_run_id, id) REFERENCES runs(id, session_id)
) STRICT;
CREATE INDEX sessions_list_idx ON sessions(project_id, archived_at, last_activity_at DESC, id);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  session_id TEXT REFERENCES sessions(id),
  scope TEXT NOT NULL,
  client_command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','accepted','completed','failed','cancelled','unknown')),
  target_run_id TEXT,
  worker_epoch TEXT,
  response_status INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  accepted_at INTEGER,
  finished_at INTEGER,
  UNIQUE(user_id, scope, client_command_id),
  UNIQUE(id, session_id),
  FOREIGN KEY(target_run_id, session_id) REFERENCES runs(id, session_id)
) STRICT;
CREATE INDEX commands_queue_idx ON commands(state, created_at, id);
CREATE INDEX commands_session_idx ON commands(session_id, state, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  operation_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('command','extension','runtime')),
  command_id TEXT REFERENCES commands(id),
  kind TEXT NOT NULL CHECK(kind IN ('prompt','compact')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_input','completed','failed','aborted','interrupted','cancelled')),
  phase TEXT,
  worker_epoch TEXT,
  worker_pid INTEGER,
  worker_start_ticks TEXT,
  process_group_id INTEGER,
  execution_scope_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK(source <> 'command' OR command_id IS NOT NULL),
  CHECK (status NOT IN ('running','waiting_input') OR (worker_epoch IS NOT NULL AND execution_scope_key IS NOT NULL)),
  UNIQUE(id, session_id)
) STRICT;
-- command_id is a causal link; same-owner validation is performed in storage transactions.
CREATE INDEX runs_command_idx ON runs(command_id, created_at, id);
CREATE UNIQUE INDEX one_active_run_per_session ON runs(session_id)
  WHERE status IN ('running','waiting_input');
CREATE INDEX runs_queue_idx ON runs(status, created_at, id);

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK(seq > 0 AND seq <= 9007199254740991),
  run_id TEXT,
  operation_id TEXT,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(session_id, seq),
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id)
) STRICT;

CREATE TABLE ipc_batches (
  worker_epoch TEXT NOT NULL,
  batch_no INTEGER NOT NULL CHECK(batch_no > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL CHECK(last_seq >= first_seq),
  payload_hash TEXT NOT NULL,
  PRIMARY KEY(worker_epoch, batch_no),
  FOREIGN KEY(session_id, first_seq) REFERENCES events(session_id, seq),
  FOREIGN KEY(session_id, last_seq) REFERENCES events(session_id, seq)
) STRICT;

-- Sealed immutable timeline items, including interrupted partial output.
-- Only still-open items live in live_state_json.
CREATE TABLE timeline_items (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('message','tool')),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial')),
  end_reason TEXT CHECK(end_reason IN ('failed','aborted','interrupted')),
  ordinal_seq INTEGER NOT NULL,
  finalized_seq INTEGER NOT NULL CHECK(finalized_seq >= ordinal_seq),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(session_id, item_id),
  CHECK ((completeness = 'complete' AND end_reason IS NULL)
    OR (completeness = 'partial' AND end_reason IS NOT NULL)),
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
  FOREIGN KEY(session_id, ordinal_seq) REFERENCES events(session_id, seq),
  FOREIGN KEY(session_id, finalized_seq) REFERENCES events(session_id, seq)
) STRICT;
CREATE INDEX timeline_page_idx ON timeline_items(session_id, ordinal_seq DESC, item_id);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  operation_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('initialize','configure','run','bash','extension')),
  run_id TEXT,
  command_id TEXT REFERENCES commands(id),
  worker_epoch TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('select','confirm','input','editor')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','resolved','cancelled','expired')),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  response_command_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  CHECK(origin <> 'run' OR run_id IS NOT NULL),
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
  FOREIGN KEY(response_command_id, session_id) REFERENCES commands(id, session_id)
) STRICT;
CREATE INDEX interactions_pending_idx ON interactions(session_id, status, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id)
) STRICT;

PRAGMA user_version = 1;
