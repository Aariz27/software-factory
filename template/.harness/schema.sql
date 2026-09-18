-- A1 Harness trace store — blueprint/.state/trace.db
-- Written by hooks (host actions) and the `sf run` wrapper (child agents).
-- Read by .harness/dashboard/server.mjs. All statements are idempotent.

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,          -- unique per host session or child agent
  parent_session_id TEXT,                      -- NULL for the host session the user typed into
  command           TEXT,                      -- the /command this session serves (feature, implement, ...)
  cli               TEXT,                      -- claude | codex | agy | ollama
  model             TEXT,                      -- exact model id as launched
  pid               INTEGER,
  sandbox           INTEGER,                   -- 1 if launched with a sandbox flag
  permission_mode   TEXT,                      -- e.g. acceptEdits, read-only, workspace-write
  allowed_tools     TEXT,                      -- JSON array
  disallowed_tools  TEXT,                      -- JSON array
  allowed_paths     TEXT,                      -- JSON array of write-scope paths
  started_at        TEXT NOT NULL,             -- ISO-8601
  ended_at          TEXT,
  exit_code         INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,                   -- ISO-8601
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                   -- tool_call | tool_result | prompt | subagent_start | subagent_stop | stop | note
  name        TEXT,                            -- tool name, subagent name, ...
  payload     TEXT,                            -- JSON, never secrets or raw prompts
  tokens_in   INTEGER,
  tokens_out  INTEGER
);

CREATE TABLE IF NOT EXISTS gates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  session_id  TEXT,
  command     TEXT,
  gate        TEXT NOT NULL,                   -- artifacts | claimed | review | test | commit-ready | diff | scope (gates.mjs gate names)
  passed      INTEGER NOT NULL,                -- 1 / 0
  evidence    TEXT                             -- tail of output, path list, ...
);

CREATE TABLE IF NOT EXISTS files_touched (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  session_id  TEXT,
  path        TEXT NOT NULL,
  claimed     INTEGER NOT NULL DEFAULT 0,      -- the agent said it changed this
  actual      INTEGER NOT NULL DEFAULT 0,      -- git saw it change
  in_scope    INTEGER,                         -- 1 / 0 / NULL when no scope declared
  reverted    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS gates_ts ON gates(ts);
