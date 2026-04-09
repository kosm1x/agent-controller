-- Mission Control database schema

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY,
  task_id        TEXT UNIQUE NOT NULL,
  parent_task_id TEXT REFERENCES tasks(task_id),
  spawn_type     TEXT DEFAULT 'root' CHECK(spawn_type IN ('root','subtask')),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  priority       TEXT DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
  status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','classifying','queued','running','completed','completed_with_concerns','needs_context','blocked','failed','cancelled')),
  agent_type     TEXT CHECK(agent_type IN ('fast','nanoclaw','heavy','swarm','a2a')),
  classification TEXT,
  assigned_to    TEXT,
  input          TEXT,
  output         TEXT,
  error          TEXT,
  progress       INTEGER DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
  metadata       TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now')),
  started_at     TEXT,
  completed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(agent_type);
CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);

CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY,
  run_id         TEXT UNIQUE NOT NULL,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  agent_type     TEXT NOT NULL,
  status         TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  phase          TEXT,
  trace          TEXT,
  goal_graph     TEXT,
  input          TEXT NOT NULL,
  output         TEXT,
  error          TEXT,
  token_usage    TEXT,
  duration_ms    INTEGER,
  runner_status  TEXT,
  container_id   TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS agents (
  id             INTEGER PRIMARY KEY,
  agent_id       TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK(type IN ('fast','nanoclaw','heavy','a2a')),
  status         TEXT DEFAULT 'offline' CHECK(status IN ('online','idle','busy','error','offline')),
  capabilities   TEXT,
  model          TEXT,
  config         TEXT,
  last_seen      TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);

-- Learnings from Prometheus reflection phase (persistent across runs)
CREATE TABLE IF NOT EXISTS learnings (
  id         INTEGER PRIMARY KEY,
  task_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT DEFAULT 'reflection',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_learnings_created ON learnings(created_at DESC);

-- Task outcome tracking (feeds adaptive classifier + enrichment)
CREATE TABLE IF NOT EXISTS task_outcomes (
  id              INTEGER PRIMARY KEY,
  task_id         TEXT NOT NULL,
  classified_as   TEXT NOT NULL,
  ran_on          TEXT NOT NULL,
  tools_used      TEXT DEFAULT '[]',
  duration_ms     INTEGER,
  success         INTEGER DEFAULT 1,
  feedback_signal TEXT DEFAULT 'none',
  tags            TEXT DEFAULT '[]',
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outcomes_runner ON task_outcomes(ran_on);
CREATE INDEX IF NOT EXISTS idx_outcomes_created ON task_outcomes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_task_id ON task_outcomes(task_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_runner_success ON task_outcomes(ran_on, success);

-- Scope telemetry (feeds self-tuning case miner)
CREATE TABLE IF NOT EXISTS scope_telemetry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT,
  message         TEXT NOT NULL,
  active_groups   TEXT DEFAULT '[]',
  tools_in_scope  TEXT DEFAULT '[]',
  tools_called    TEXT DEFAULT '[]',
  tools_repaired  TEXT DEFAULT '[]',
  tools_failed    TEXT DEFAULT '[]',
  feedback_signal TEXT DEFAULT 'none',
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scope_tel_task ON scope_telemetry(task_id);
CREATE INDEX IF NOT EXISTS idx_scope_tel_created ON scope_telemetry(created_at DESC);

-- Saved skills (reusable multi-step procedures)
CREATE TABLE IF NOT EXISTS skills (
  id            INTEGER PRIMARY KEY,
  skill_id      TEXT UNIQUE NOT NULL,
  name          TEXT UNIQUE NOT NULL,
  description   TEXT NOT NULL,
  trigger_text  TEXT NOT NULL,
  steps         TEXT NOT NULL DEFAULT '[]',
  tools         TEXT NOT NULL DEFAULT '[]',
  use_count     INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  source        TEXT DEFAULT 'manual',
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  last_used     TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(active);

-- Conversation memory (works with any memory backend)
-- trust_tier: 1=verified (user confirmed), 2=inferred (reflector/ritual),
--             3=provisional (LLM during task), 4=unverified (tool results)
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY,
  bank       TEXT NOT NULL DEFAULT 'mc-jarvis',
  tags       TEXT DEFAULT '[]',
  content    TEXT NOT NULL,
  trust_tier INTEGER NOT NULL DEFAULT 3,
  source     TEXT DEFAULT 'agent',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_bank ON conversations(bank);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_bank_created ON conversations(bank, created_at DESC);

-- FTS5 full-text search index (external content table — no data duplication)
CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
  content,
  content='conversations',
  content_rowid='id'
);

-- Triggers to keep FTS5 in sync with conversations
CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
  INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Embedding vectors for semantic search (384-dim float32 as BLOB)
CREATE TABLE IF NOT EXISTS conversation_embeddings (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
  embedding       BLOB NOT NULL
);

-- User facts — structured personal facts that persist across sessions
CREATE TABLE IF NOT EXISTS user_facts (
  id         INTEGER PRIMARY KEY,
  category   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  source     TEXT DEFAULT 'conversation',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(category, key)
);
CREATE INDEX IF NOT EXISTS idx_user_facts_category ON user_facts(category);

-- Projects — first-class project entity with credentials, config, and NorthStar goal linking
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  urls            TEXT DEFAULT '{}',   -- JSON: { site, admin, repo, dashboard }
  credentials     TEXT DEFAULT '{}',   -- JSON: { wp_user, wp_pass, ftp_host, api_keys }
  config          TEXT DEFAULT '{}',   -- JSON: arbitrary project config
  commit_goal_id  TEXT,                -- NorthStar goal UUID (links project to a strategic goal; column name is legacy)
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- Project activity log — changelog of everything Jarvis does on a project
CREATE TABLE IF NOT EXISTS project_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  details     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_log_project ON project_log(project_id);

-- Legacy event log — table retained for schema compatibility (no longer actively used)
CREATE TABLE IF NOT EXISTS commit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,  -- INSERT, UPDATE, DELETE
  table_name  TEXT NOT NULL,  -- tasks, goals, objectives, journal_entries
  row_id      TEXT NOT NULL,  -- UUID of the changed row
  user_id     TEXT,
  modified_by TEXT DEFAULT 'user',  -- user, jarvis, system
  changes     TEXT,           -- JSON of changed fields
  processed   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commit_events_processed ON commit_events(processed) WHERE processed = 0;

-- Strategy bullets — ACE-inspired per-instruction scoring (helpful/harmful counters)
-- Structured playbook entries that evolve based on task outcomes.
CREATE TABLE IF NOT EXISTS strategy_bullets (
  id             INTEGER PRIMARY KEY,
  bullet_id      TEXT UNIQUE NOT NULL,
  section        TEXT NOT NULL,
  content        TEXT NOT NULL,
  helpful_count  INTEGER DEFAULT 0,
  harmful_count  INTEGER DEFAULT 0,
  source         TEXT DEFAULT 'reflector',
  active         INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bullets_active ON strategy_bullets(active);
CREATE INDEX IF NOT EXISTS idx_bullets_section ON strategy_bullets(section);

-- A2A context-to-task mapping (for multi-turn conversations)
CREATE TABLE IF NOT EXISTS a2a_contexts (
  context_id  TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_a2a_ctx_task ON a2a_contexts(task_id);

-- Hermes H2: Reflection drift baselines — rolling score history per task type
CREATE TABLE IF NOT EXISTS reflection_baselines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type   TEXT NOT NULL,
  score       REAL NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refl_baselines_type ON reflection_baselines(task_type, created_at DESC);

-- Hermes H3: Schedule run audit trail — per-execution history for recurring tasks
CREATE TABLE IF NOT EXISTS schedule_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id     TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  spawned_at      TEXT DEFAULT (datetime('now')),
  status          TEXT DEFAULT 'running',
  result_summary  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_runs_schedule ON schedule_runs(schedule_id, spawned_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_runs_task ON schedule_runs(task_id);
