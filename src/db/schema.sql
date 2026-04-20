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

-- Embedding vectors for semantic search (1536-dim float32 as BLOB)
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

-- v7.3 Phase 1: SEO/GEO audit history — tracks page/keyword/site audits over time
CREATE TABLE IF NOT EXISTS seo_audits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT NOT NULL,
  url         TEXT,
  audit_type  TEXT NOT NULL CHECK (audit_type IN ('page','keyword','site')),
  score       INTEGER,
  findings    TEXT NOT NULL,   -- JSON: { priorities[], issues[], recommendations[] }
  metadata    TEXT,            -- JSON: raw crawl/LLM data for diffing
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seo_audits_domain ON seo_audits(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_audits_url ON seo_audits(url, created_at DESC);

-- Autoreason Phase 1: Generation-evaluation gap telemetry
-- Logs divergence between the reflector's LLM judge score and the heuristic
-- goal-completion ratio for each task. Used to measure whether the base
-- model's self-evaluation capability matches its generation capability —
-- the central claim of the autoreason paper. If the gap is wide, further
-- lifts (tournament judging, fresh-agent evaluation) may pay off. If narrow,
-- structured refinement adds no value and we stay with the current design.
CREATE TABLE IF NOT EXISTS reflector_gap_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL,
  llm_score         REAL NOT NULL,
  heuristic_score   REAL NOT NULL,
  abs_diff          REAL NOT NULL,
  llm_available     INTEGER NOT NULL,  -- 0 if fell back to heuristic, 1 otherwise
  goals_total       INTEGER NOT NULL,
  goals_completed   INTEGER NOT NULL,
  goals_failed      INTEGER NOT NULL,
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reflector_gap_task ON reflector_gap_log(task_id);
CREATE INDEX IF NOT EXISTS idx_reflector_gap_created ON reflector_gap_log(created_at DESC);

-- v7.7 Jarvis MCP Server — bearer token store.
-- Read-only tokens for Claude Code sessions to query live Jarvis state
-- (memory, tasks, schedules, feedback, gap telemetry) via the /mcp route.
-- Tokens are SHA-256 hashed at rest; raw bearer shown exactly once at
-- mc-ctl mcp-token create time. No retrieval, no plaintext storage.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL UNIQUE,
  client_name   TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'read_only' CHECK(scope IN ('read_only')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,
  expires_at    TEXT,                                       -- v7.7.1 optional expiry (ISO datetime, NULL = no expiry)
  revoked       INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash) WHERE revoked = 0;

-- ===========================================================================
-- F1 Data Layer (v7.0 Phase β, session 72) — 6 tables for Financial Stack
-- ===========================================================================

CREATE TABLE IF NOT EXISTS market_data (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK(provider IN ('alpha_vantage','polygon','fmp','fred','manual')),
  interval        TEXT NOT NULL CHECK(interval IN ('1min','5min','15min','60min','daily','weekly','monthly')),
  timestamp       TEXT NOT NULL,                              -- ISO 8601 America/New_York
  open            REAL NOT NULL,
  high            REAL NOT NULL,
  low             REAL NOT NULL,
  close           REAL NOT NULL,
  volume          INTEGER NOT NULL,
  adjusted_close  REAL,                                       -- for dividend/split adjustment
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, provider, interval, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_market_data_symbol_ts ON market_data(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_data_interval ON market_data(interval, timestamp DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  symbol          TEXT PRIMARY KEY,
  name            TEXT,
  asset_class     TEXT NOT NULL CHECK(asset_class IN ('equity','etf','fx','commodity','crypto','macro')),
  tags            TEXT NOT NULL DEFAULT '[]',                 -- JSON array
  active          INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id     TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  win_rate        REAL,
  sharpe          REAL,
  max_drawdown    REAL,
  total_trades    INTEGER,
  regime          TEXT,                                       -- bull/bear/volatile/calm at time of test
  metadata        TEXT,                                       -- JSON per-strategy config snapshot
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_results(strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_theses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  thesis_text     TEXT NOT NULL,
  entry_signal    TEXT NOT NULL,
  entry_price     REAL,
  entry_time      TEXT,
  exit_condition  TEXT NOT NULL,
  exit_price      REAL,
  exit_time       TEXT,
  pnl             REAL,
  pnl_pct         REAL,
  outcome         TEXT CHECK(outcome IN ('open','closed_profit','closed_loss','closed_breakeven','stopped_out')),
  metadata        TEXT,                                       -- JSON signal chain, regime, confidence
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_theses_symbol ON trade_theses(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_theses_outcome ON trade_theses(outcome);

CREATE TABLE IF NOT EXISTS api_call_budget (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT NOT NULL,
  call_time         TEXT NOT NULL DEFAULT (datetime('now')),
  endpoint          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('success','rate_limited','error','timeout')),
  response_time_ms  INTEGER,
  cost_units        INTEGER NOT NULL DEFAULT 1                -- NEWS_SENTIMENT = 25, normal = 1
);
CREATE INDEX IF NOT EXISTS idx_budget_provider_time ON api_call_budget(provider, call_time DESC);

-- F3 placeholder (renamed from 'signals' to avoid collision with intel signals table).
CREATE TABLE IF NOT EXISTS market_signals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol               TEXT NOT NULL,
  signal_type          TEXT NOT NULL,                         -- ma_crossover, rsi_extreme, macd_cross, etc.
  direction            TEXT NOT NULL CHECK(direction IN ('long','short','neutral')),
  strength             REAL NOT NULL,                         -- 0-1
  triggered_at         TEXT NOT NULL,
  indicators_snapshot  TEXT,                                  -- JSON state at trigger
  metadata             TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_signals_symbol_time ON market_signals(symbol, triggered_at DESC);

-- ===========================================================================
-- F6 + F6.5 external signal layers (v7.0 Phase β, session 75) — 3 tables
-- Prediction markets + whale tracker + sentiment readings
-- ===========================================================================

CREATE TABLE IF NOT EXISTS prediction_markets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL CHECK(source IN ('polymarket','kalshi','manual')),
  market_id       TEXT NOT NULL,                              -- Polymarket condition_id or slug
  slug            TEXT,
  question        TEXT NOT NULL,
  category        TEXT,
  resolution_date TEXT,
  outcome_tokens  TEXT,                                        -- JSON array of {id, outcome, price}
  volume_usd      REAL,
  liquidity_usd   REAL,
  is_neg_risk     INTEGER DEFAULT 0 CHECK(is_neg_risk IN (0,1)),
  event_id        TEXT,                                        -- Gamma events grouping
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, market_id)
);
CREATE INDEX IF NOT EXISTS idx_prediction_markets_source ON prediction_markets(source, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_markets_event ON prediction_markets(event_id);

CREATE TABLE IF NOT EXISTS whale_trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL CHECK(source IN ('polymarket','sec_edgar','manual')),
  wallet          TEXT NOT NULL,
  market_id       TEXT,                                        -- Polymarket market or ticker for SEC
  side            TEXT CHECK(side IN ('buy','sell','long','short')),
  size_usd        REAL,
  price           REAL,
  occurred_at     TEXT NOT NULL,
  metadata        TEXT,                                        -- JSON
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whale_trades_wallet ON whale_trades(wallet, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_whale_trades_market ON whale_trades(market_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS sentiment_readings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,                               -- 'alternative_me', 'cmc_fng', 'binance_funding'
  indicator       TEXT NOT NULL,                               -- 'fear_greed', 'funding_rate', 'liquidation', 'stablecoin_flow'
  symbol          TEXT,                                        -- NULL for broad indicators
  value           REAL NOT NULL,
  value_text      TEXT,                                        -- classification e.g. "Greed", "Extreme Fear"
  observed_at     TEXT NOT NULL,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, indicator, symbol, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_sentiment_readings_indicator ON sentiment_readings(indicator, observed_at DESC);

-- ===========================================================================
-- F7 Alpha Combination Engine (v7.0 Phase β, session 77) — 2 tables
-- signal_weights: append-only per-run weight log. Read by run_id (never by
--   "latest" column-wise) — F8 + F9 pick the most-recent completed run_id.
-- signal_isq: per-signal-per-run Ingredient Signal Quality dimensions.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS signal_weights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                               -- UUID generated per F7 run
  run_timestamp   TEXT NOT NULL,                               -- ISO 8601 America/New_York
  mode            TEXT NOT NULL CHECK(mode IN ('returns','probability')),
  signal_key      TEXT NOT NULL,                               -- "{type}:{symbol}" or "{source}:{indicator}:{symbol}"
  signal_name     TEXT NOT NULL,                               -- snapshot display name at run time
  weight          REAL NOT NULL,                               -- w(i) from Step 10; 0 if excluded
  epsilon         REAL,                                        -- residual ε(i); null if excluded
  sigma           REAL,                                        -- σ(i); null if excluded pre-variance
  e_norm          REAL,                                        -- E_normalized(i); null if excluded
  ic_30d          REAL,                                        -- 30-day IC snapshot; null if <30 firings
  regime          TEXT,                                        -- F5 regime label or null
  n_effective     REAL,                                        -- 1 / Σw² redundant per row for queryability
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  exclude_reason  TEXT,                                        -- 'missing_data','ic_le_zero','flat_variance','correlated','singular'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Audit W5: one signal_key per run_id; prevents accidental double-writes.
  UNIQUE(run_id, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_signal_weights_run ON signal_weights(run_id);
CREATE INDEX IF NOT EXISTS idx_signal_weights_time ON signal_weights(run_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_signal_weights_signal ON signal_weights(signal_key, run_timestamp DESC);
-- Unique index is equivalent to UNIQUE constraint and is additive on live DBs
-- where the original CREATE TABLE shipped without the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_weights_runkey
  ON signal_weights(run_id, signal_key);

CREATE TABLE IF NOT EXISTS signal_isq (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                               -- logical FK to signal_weights.run_id
  signal_key      TEXT NOT NULL,
  efficiency      REAL NOT NULL,
  timeliness      REAL NOT NULL,
  coverage        REAL NOT NULL,
  stability       REAL NOT NULL,
  forward_ic      REAL NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_signal_isq_run ON signal_isq(run_id, signal_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_isq_runkey
  ON signal_isq(run_id, signal_key);

-- ============================================================================
-- F7.5 — Strategy Backtester (Phase β S10)
-- CPCV (Combinatorial Purged Cross-Validation) + PBO + DSR overfit firewall.
-- All tables additive, live-applicable via `sqlite3 data/mc.db < schema.sql`.
-- Weekly-first: one bar = one week; rebalance_bars default = 1.
-- ============================================================================

CREATE TABLE IF NOT EXISTS backtest_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL UNIQUE,                       -- UUID
  run_timestamp     TEXT NOT NULL,                              -- ISO 8601 America/New_York
  strategy          TEXT NOT NULL,                              -- 'flam' at v1; 'equal_weight' baseline
  mode              TEXT NOT NULL CHECK(mode IN ('returns','probability')),
  window_start      TEXT NOT NULL,                              -- ISO date, first bar
  window_end        TEXT NOT NULL,                              -- ISO date, last bar
  cost_bps          REAL NOT NULL DEFAULT 5,
  rebalance_bars    INTEGER NOT NULL DEFAULT 1,                 -- weekly: 1 bar = 1 week
  -- Walk-forward summary
  wf_sharpe         REAL,
  wf_cum_return     REAL,
  wf_max_drawdown   REAL,
  wf_calmar         REAL,
  wf_win_rate       REAL,
  wf_total_trades   INTEGER,
  -- CPCV aggregate
  cpcv_n_trials     INTEGER,                                    -- trial grid size
  cpcv_n_folds      INTEGER,                                    -- C(N, k)
  cpcv_sharpe_mean  REAL,
  cpcv_sharpe_std   REAL,
  cpcv_n_aborted    INTEGER NOT NULL DEFAULT 0,                 -- trials × folds that errored
  -- Overfit firewall
  pbo               REAL,                                       -- [0, 1]
  dsr_ratio         REAL,
  dsr_pvalue        REAL,
  ship_blocked      INTEGER NOT NULL DEFAULT 0 CHECK(ship_blocked IN (0,1)),
  override_ship     INTEGER NOT NULL DEFAULT 0 CHECK(override_ship IN (0,1)),
  regime            TEXT,                                       -- dominant F5 regime over window; nullable
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_time ON backtest_runs(run_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy ON backtest_runs(strategy, run_timestamp DESC);

CREATE TABLE IF NOT EXISTS backtest_paths (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL,                               -- logical FK to backtest_runs.run_id
  trial_index      INTEGER NOT NULL,                            -- 0..N_trials-1 in grid order
  fold_index       INTEGER NOT NULL,                            -- 0..N_folds-1
  window_m         INTEGER NOT NULL,
  window_d         INTEGER NOT NULL,
  corr_threshold   REAL NOT NULL,
  is_sharpe        REAL,                                        -- in-sample Sharpe on train
  oos_sharpe       REAL,                                        -- out-of-sample Sharpe on test
  oos_cum_return   REAL,
  oos_n_bars       INTEGER,
  aborted          INTEGER NOT NULL DEFAULT 0 CHECK(aborted IN (0,1)),
  abort_reason     TEXT,                                        -- 'correlated_signals','too_few_firings',...
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, trial_index, fold_index)
);
CREATE INDEX IF NOT EXISTS idx_backtest_paths_run ON backtest_paths(run_id, trial_index, fold_index);

CREATE TABLE IF NOT EXISTS backtest_overfit (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL UNIQUE,                   -- one-row-per-run
  pbo                   REAL NOT NULL,                          -- [0, 1]
  pbo_threshold         REAL NOT NULL DEFAULT 0.5,
  dsr_observed_sharpe   REAL NOT NULL,
  dsr_expected_null     REAL NOT NULL,                          -- SR_expected_under_null term
  dsr_sharpe_variance   REAL NOT NULL,                          -- V[SR_trials]
  dsr_skewness          REAL,
  dsr_kurtosis          REAL,
  dsr_ratio             REAL NOT NULL,
  dsr_pvalue            REAL NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- F8 — Paper Trading (Phase β S11)
-- Equity paper trader consuming F7 weights + F7.5 ship_gate. Weekly rebalance.
-- Reuses trade_theses (per-rebalance snapshot, symbol='PORTFOLIO' sentinel).
-- Additive, live-applicable via `sqlite3 data/mc.db < schema.sql`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS paper_balance (
  account         TEXT PRIMARY KEY DEFAULT 'default',
  cash            REAL NOT NULL DEFAULT 100000,
  initial_cash    REAL NOT NULL DEFAULT 100000,
  last_updated    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_portfolio (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account         TEXT NOT NULL DEFAULT 'default',
  symbol          TEXT NOT NULL,
  shares          REAL NOT NULL,                              -- fractional allowed
  avg_cost        REAL NOT NULL,                              -- weighted average entry
  opened_at       TEXT NOT NULL,                              -- first buy timestamp
  last_updated    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account, symbol)
);
CREATE INDEX IF NOT EXISTS idx_paper_portfolio_account
  ON paper_portfolio(account, symbol);

CREATE TABLE IF NOT EXISTS paper_fills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id         TEXT NOT NULL UNIQUE,                       -- UUID from adapter
  thesis_id       INTEGER,                                    -- FK trade_theses.id (logical)
  account         TEXT NOT NULL DEFAULT 'default',
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  shares          REAL NOT NULL,
  fill_price      REAL NOT NULL,
  gross_notional  REAL NOT NULL,
  commission      REAL NOT NULL DEFAULT 0,
  slippage_bps    REAL NOT NULL DEFAULT 0,
  realized_pnl    REAL,                                       -- non-null for sells
  filled_at       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_fills_account_time
  ON paper_fills(account, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_fills_symbol
  ON paper_fills(symbol, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_fills_thesis
  ON paper_fills(thesis_id);

-- ============================================================================
-- F9 — Morning/EOD market scan rituals (Phase β S12)
-- Dynamic alert budget per ritual per day. Additive; live-applicable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_budget (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,                              -- ISO YYYY-MM-DD in America/New_York
  ritual_id       TEXT NOT NULL,                              -- 'market-morning-scan' | 'market-eod-scan' | ...
  tokens_consumed INTEGER NOT NULL DEFAULT 0,
  tokens_limit    INTEGER NOT NULL,
  exhausted_at    TEXT,                                       -- ISO timestamp when budget first hit 0
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, ritual_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_budget_date ON alert_budget(date DESC);

-- ============================================================================
-- F8.1a — Prediction-Market Alpha Layer (β-addendum)
-- Per-token weights from simplified 3-feature model over Polymarket tokens.
-- Additive; live-applicable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pm_signal_weights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                              -- UUID
  run_timestamp   TEXT NOT NULL,                              -- ISO 8601 America/New_York
  market_id       TEXT NOT NULL,                              -- Polymarket condition_id
  slug            TEXT,                                        -- convenience field
  outcome         TEXT NOT NULL,                              -- 'YES' | 'NO' | custom
  token_id        TEXT,                                        -- CLOB token_id; nullable
  market_price    REAL NOT NULL,                              -- midpoint 0..1 at run time
  p_estimate      REAL NOT NULL,                              -- our estimate 0..1
  edge            REAL NOT NULL,                              -- p_estimate - market_price
  whale_flow_usd  REAL,                                        -- signed; null if no data
  sentiment_tilt  REAL NOT NULL DEFAULT 0,                    -- [-0.02, +0.02]
  kelly_raw       REAL NOT NULL,                              -- pre-clip
  weight          REAL NOT NULL,                              -- post-clip, signed
  liquidity_usd   REAL,
  resolution_date TEXT,
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  exclude_reason  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, market_id, outcome)
);
CREATE INDEX IF NOT EXISTS idx_pm_signal_weights_run
  ON pm_signal_weights(run_id);
CREATE INDEX IF NOT EXISTS idx_pm_signal_weights_market
  ON pm_signal_weights(market_id, run_timestamp DESC);

-- ============================================================================
-- F8.1b — PolymarketPaperAdapter (β-addendum)
-- Parallel to F8 equity paper tables; keyed by (market_id, outcome) instead
-- of symbol. USDC-denominated balance. Additive; live-applicable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pm_paper_balance (
  account         TEXT PRIMARY KEY DEFAULT 'default',
  cash_usdc       REAL NOT NULL DEFAULT 10000,
  initial_cash    REAL NOT NULL DEFAULT 10000,
  last_updated    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pm_paper_portfolio (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account         TEXT NOT NULL DEFAULT 'default',
  market_id       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  token_id        TEXT,
  slug            TEXT,
  shares          REAL NOT NULL,                              -- 4dp fractional
  avg_cost        REAL NOT NULL,                              -- USDC / share; ≤ 1
  opened_at       TEXT NOT NULL,
  last_updated    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account, market_id, outcome)
);
CREATE INDEX IF NOT EXISTS idx_pm_paper_portfolio_account
  ON pm_paper_portfolio(account);

CREATE TABLE IF NOT EXISTS pm_paper_fills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id         TEXT NOT NULL UNIQUE,                       -- UUID
  thesis_id       INTEGER,                                    -- logical FK to trade_theses
  account         TEXT NOT NULL DEFAULT 'default',
  market_id       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  token_id        TEXT,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  shares          REAL NOT NULL,
  fill_price      REAL NOT NULL,                              -- midpoint ± slippage
  gross_notional  REAL NOT NULL,
  slippage_bps    REAL NOT NULL DEFAULT 0,
  realized_pnl    REAL,                                        -- non-null on sells
  filled_at       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_paper_fills_account_time
  ON pm_paper_fills(account, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_paper_fills_market
  ON pm_paper_fills(market_id, outcome, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_paper_fills_thesis
  ON pm_paper_fills(thesis_id);

-- v7.1 chart pattern persistence — vision LLM output
CREATE TABLE IF NOT EXISTS chart_patterns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  interval      TEXT NOT NULL CHECK(interval IN ('daily','weekly')),
  pattern_label TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  candle_start  INTEGER,
  candle_end    INTEGER,
  png_path      TEXT,
  rationale     TEXT,
  detected_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chart_patterns_symbol_detected
  ON chart_patterns(symbol, detected_at DESC);
