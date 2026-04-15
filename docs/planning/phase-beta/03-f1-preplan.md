# F1 Data Layer — Pre-plan (DRAFT)

> **Phase:** β (Financial Stack v7.0)
> **Session estimate:** 1.7 sessions (revised from 1.5 after Yahoo replacement)
> **Status:** PRE-PLAN DRAFT — not approved, not implemented
> **Blockers:** Alpha Vantage budget decision + Yahoo replacement decision

---

## Context

F1 is the foundation of the entire F-series. It owns the 6-table schema, the market-data adapter layer, validation, timezone normalization, and API budget tracking. Every downstream F-session (F2 indicators, F3 signals, F4 watchlist, F5 macro, F6 prediction markets, F7 alpha combo, F7.5 backtester, F8 paper trading, F9 rituals) reads from the tables F1 creates.

If F1 ships with a schema gap or a validation hole, every downstream session works around it instead of fixing it. That's the most expensive kind of error in a critical-path stack.

## Decisions LOCKED (operator 2026-04-14)

All six operator decisions answered. F1 pre-plan is now implementation-ready subject to the readiness gate clearing on ~2026-04-17.

### Decision 1: Alpha Vantage tier — ✅ LOCKED: **$49.99/mo**

- [x] **$49.99/mo** — 75 req/min — sufficient for 20-30 symbol watchlist + daily macro pulls
- [ ] $149.99/mo — 300 req/min
- [ ] $249.99/mo — 1,200 req/min

**Operating cost:** $49.99/mo baseline for v7.0. `api_call_budget` table enforces 80% ceiling so we never silently exceed tier 1.

**Credential provisioning:** ✅ **`ALPHAVANTAGE_API_KEY` provisioned in `.env` on 2026-04-15** (verified via non-leaking grep count). **Note the env var name has no underscore between "ALPHA" and "VANTAGE"** — F1's `AlphaVantageAdapter` must read `process.env.ALPHAVANTAGE_API_KEY`, NOT `process.env.ALPHA_VANTAGE_API_KEY`. The config loader in `src/config.ts` should expose this as `config.alphaVantageApiKey` so the adapter never touches `process.env` directly — standard pattern for the rest of our API keys.

### Decision 2: F1 fallback source — ✅ LOCKED: **Polygon.io free tier**

- [x] **Polygon.io free** — 5 req/min, 2-year historical, real-time WebSocket
- [ ] Financial Modeling Prep free
- [ ] IEX Cloud paid
- [ ] stooq.com unofficial
- [ ] No fallback

**Implementation note:** `PolygonAdapter` replaces the original `YahooFinanceAdapter`. Same interface surface where possible. Macro series NOT implemented on Polygon (macro is FRED-only). Rate limit guarded by a per-minute local counter with exponential backoff.

**Hostname config (from exploration item C, see `08-polygon-verification.md`):** polygon.io rebranded to Massive in early 2026. `PolygonAdapter` uses `api.massive.com` as the primary hostname and `api.polygon.io` as a transparent legacy alias (identical responses verified on both). Timestamp field `t` is unix **milliseconds UTC** — F1's `timezone.ts` must convert to America/New_York before insert.

**Credential provisioning:** ✅ **`POLYGON_API_KEY` provisioned in `.env` on 2026-04-15.** Only the REST API Key is needed — Massive also issues S3-style Access Key ID + Secret Access Key credentials for flat-file bulk downloads, but Phase β doesn't need them (26-symbol × 2-year daily backfill = 26 REST requests, comfortably inside the free tier's 5 req/min).

### Decision 3: Initial watchlist — ✅ LOCKED: **default 20-30 list**

**Equities + ETFs (20):** SPY, QQQ, DIA, IWM, VXX, GLD, TLT, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, JPM, BAC, XLF, XLE, XLK, XLV

**FX (3):** EURUSD, USDJPY, GBPUSD

**Macro (6):** FEDFUNDS, CPI, NONFARM (all via Alpha Vantage), VIXCLS, ICSA, M2SL (all via FRED)

**Total:** 29 tracked symbols/series at F1 launch.

**Design requirement per operator:** Changing the watchlist MUST be a trivial task for Jarvis via natural-language invocation. This is not optional polish — it's a first-class F1 acceptance criterion.

Concretely, this means:

- `market_watchlist_add`, `market_watchlist_remove`, `market_watchlist_list` tools get high-quality ACI descriptions following the v6.0 ACI design principles in CLAUDE.md (edge cases, enums, `.describe()` on every Zod field, poka-yoke for symbol input)
- The `finance` scope group regex must fire on natural-language watchlist verbs in both Spanish and English: `/\b(agrega|añade|quita|elimina|muestra|lista|add|remove|show|list)\b.*\b(watchlist|watch\s*list|ticker|symbol|s[ií]mbolo|acci[oó]n)\b/i` plus symbol-pattern activation (`$SPY`, `SPY`, `AAPL`, etc.)
- A smoke test at the end of F1 verifies "Jarvis, agrega TSLA a mi watchlist" → scope activates → `market_watchlist_add` fires with `{symbol: "TSLA", asset_class: "equity"}` → confirmation reply
- Error messages from the tools are operator-friendly (not Zod validation stacktraces): "Ese símbolo no está en un formato válido (ejemplo válido: SPY, AAPL)"

**Why this matters:** The watchlist is the only part of F1 the operator touches directly. Every other part is invisible infrastructure. If adding a symbol takes more than one WhatsApp message, F1 failed the usability test regardless of test coverage.

### Decision 4: Macro series scope — ✅ LOCKED: **FRED + Alpha Vantage (both sources)**

Both macro sources are used — AV for what AV has, FRED for what FRED has. Overlapping series (e.g., FEDFUNDS exists in both) default to Alpha Vantage for consistency with the equity/FX data provenance; FRED is the authoritative source for series AV doesn't expose.

**Source split:**

| Series                        | Provider      | Rationale              |
| ----------------------------- | ------------- | ---------------------- |
| FEDFUNDS (Federal Funds Rate) | Alpha Vantage | AV macro endpoint      |
| TREASURY_YIELD                | Alpha Vantage | AV macro endpoint      |
| CPI                           | Alpha Vantage | AV macro endpoint      |
| UNEMPLOYMENT                  | Alpha Vantage | AV macro endpoint      |
| NONFARM_PAYROLL               | Alpha Vantage | AV macro endpoint      |
| REAL_GDP                      | Alpha Vantage | AV macro endpoint      |
| VIXCLS (VIX close)            | FRED          | AV doesn't expose VIX  |
| ICSA (Initial Jobless Claims) | FRED          | AV doesn't expose ICSA |
| M2SL (M2 Money Stock)         | FRED          | AV doesn't expose M2   |

F5 (Macro Regime Detection) reads from both `AlphaVantageAdapter.fetchMacroSeries()` and `FredAdapter.fetchSeries()` depending on which series it needs. The `DataLayer.getMacro()` facade hides the split from callers.

### Decision 5: Second sentiment source for F6.5 — ✅ LOCKED: **CoinMarketCap Fear & Greed (free)**

- [ ] LunarCrush — $20/mo (deferred, too early to pay)
- [ ] Santiment — $30/mo (deferred)
- [x] **CoinMarketCap Fear & Greed** — free, different methodology than alternative.me
- [ ] Defer entirely

**Impact on F6.5 scope:** Two sentiment adapters ship together — `AlternativeMeAdapter` and `CoinMarketCapFearGreedAdapter`. The F6.5 aggregator blends both readings (simple average or weighted by methodology confidence — to be decided in F6.5 pre-plan). Zero added operating cost. F6.5 session estimate stays at 0.7 sessions.

**Future upgrade path:** If CoinMarketCap F&G turns out to correlate too tightly with alternative.me (both are market-sentiment aggregators), we can add LunarCrush/Santiment later as a third paid leg for on-chain + social depth. Not required at launch.

### Decision 6: γ interleave during β — ✅ LOCKED: **NO — finish β first**

Phase γ (v7.2 Graphify, v7.3 P2 SEO telemetry, v7.3 P3/P4, v7.4, v7.5) is strictly deferred until F9 exits the Phase β critical path. No interleaving, no slotting, no "while F7 compiles" detours.

**Implication:** The ordering map in `04-ordering-map.md` is now the authoritative schedule. S1-S9 all contain only F-series work. γ work begins in S10+ after F9 ships and Phase β's validation window opens.

---

## Schema (6 tables, additive DDL, applies live)

### market_data

Primary store for all OHLCV data from all providers. Provider field disambiguates source.

```sql
CREATE TABLE IF NOT EXISTS market_data (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK(provider IN ('alpha_vantage','polygon','fmp','fred','manual')),
  interval        TEXT NOT NULL CHECK(interval IN ('1min','5min','15min','60min','daily','weekly','monthly')),
  timestamp       TEXT NOT NULL,               -- ISO 8601 in America/New_York (NYSE market time)
  open            REAL NOT NULL,
  high            REAL NOT NULL,
  low             REAL NOT NULL,
  close           REAL NOT NULL,
  volume          INTEGER NOT NULL,
  adjusted_close  REAL,                         -- for dividend/split adjustment
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, provider, interval, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_market_data_symbol_ts ON market_data(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_data_interval ON market_data(interval, timestamp DESC);
```

### watchlist

Operator's tracked symbols. Tags enable sector/regime grouping.

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  symbol          TEXT PRIMARY KEY,
  name            TEXT,
  asset_class     TEXT NOT NULL CHECK(asset_class IN ('equity','etf','fx','commodity','crypto','macro')),
  tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array
  active          INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT
);
```

### backtest_results

Per-strategy results from F7.5. Pre-allocated here to avoid schema migration later.

```sql
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
  regime          TEXT,                         -- bull/bear/volatile/calm classification at time of test
  metadata        TEXT,                         -- JSON: per-strategy config snapshot
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_results(strategy_id, created_at DESC);
```

### trade_theses

Thesis → trade → outcome commitment log. Pre-allocated for F8 paper trading.

```sql
CREATE TABLE IF NOT EXISTS trade_theses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  thesis_text     TEXT NOT NULL,                -- operator or agent reasoning
  entry_signal    TEXT NOT NULL,                -- which signal fired
  entry_price     REAL,
  entry_time      TEXT,
  exit_condition  TEXT NOT NULL,                -- pre-committed exit rule
  exit_price      REAL,
  exit_time       TEXT,
  pnl             REAL,
  pnl_pct         REAL,
  outcome         TEXT CHECK(outcome IN ('open','closed_profit','closed_loss','closed_breakeven','stopped_out')),
  metadata        TEXT,                         -- JSON: signal chain, regime, confidence
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_theses_symbol ON trade_theses(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_theses_outcome ON trade_theses(outcome);
```

### api_call_budget

Per-provider rate-limit tracking. Load-bearing for not exceeding $49.99 Alpha Vantage tier.

```sql
CREATE TABLE IF NOT EXISTS api_call_budget (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,
  call_time       TEXT NOT NULL DEFAULT (datetime('now')),
  endpoint        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('success','rate_limited','error','timeout')),
  response_time_ms INTEGER,
  cost_units      INTEGER NOT NULL DEFAULT 1    -- some endpoints cost more (e.g., NEWS_SENTIMENT = 25 units)
);
CREATE INDEX IF NOT EXISTS idx_budget_provider_time ON api_call_budget(provider, call_time DESC);
```

### signals

Pre-allocated for F3. Placeholder with minimal shape; F3 adds columns if needed.

```sql
CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  signal_type     TEXT NOT NULL,                -- ma_crossover, rsi_extreme, macd_cross, etc.
  direction       TEXT NOT NULL CHECK(direction IN ('long','short','neutral')),
  strength        REAL NOT NULL,                -- 0-1
  triggered_at    TEXT NOT NULL,
  indicators_snapshot TEXT,                     -- JSON: state of all indicators at trigger time
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals(symbol, triggered_at DESC);
```

---

## Adapters

### AlphaVantageAdapter (primary)

**File:** `src/finance/adapters/alpha-vantage.ts` (new)

```typescript
export interface AlphaVantageAdapter {
  fetchDailyAdjusted(
    symbol: string,
    opts?: { outputSize?: "compact" | "full" },
  ): Promise<MarketBar[]>;
  fetchIntraday(
    symbol: string,
    interval: "1min" | "5min" | "15min" | "60min",
  ): Promise<MarketBar[]>;
  fetchFxDaily(from: string, to: string): Promise<MarketBar[]>;
  fetchNewsSentiment(tickers: string[], opts?: NewsOpts): Promise<NewsResult[]>;
  fetchMacroSeries(series: MacroSeriesName): Promise<MacroPoint[]>; // F5 reuses this
}
```

Wraps the Alpha Vantage REST API, handles rate limit retry-after, writes every call to `api_call_budget` before returning, normalizes all timestamps to America/New_York via the TZ helper.

### PolygonAdapter (fallback)

**File:** `src/finance/adapters/polygon.ts` (new)

Same interface as AlphaVantage where possible. `fetchMacroSeries` NOT implemented — macro is FRED-only. Handles 5 req/min rate limit with exponential backoff and a per-minute local counter.

### FredAdapter

**File:** `src/finance/adapters/fred.ts` (new)

```typescript
export interface FredAdapter {
  fetchSeries(
    seriesId: string,
    opts?: { startDate?: string; endDate?: string },
  ): Promise<MacroPoint[]>;
}
```

Wraps FRED REST API. Used by F5 macro regime detection for VIX (VIXCLS), ICSA, M2 (M2SL), and any other non-AV macro series. Free, 120 req/min — generous.

### DataLayer facade

**File:** `src/finance/data-layer.ts` (new)

```typescript
export interface DataLayer {
  getDaily(symbol: string, lookback: number): Promise<MarketBar[]>;
  getIntraday(
    symbol: string,
    interval: Interval,
    lookback: number,
  ): Promise<MarketBar[]>;
  getMacro(series: MacroSeriesName, lookback: number): Promise<MacroPoint[]>;
  addToWatchlist(
    symbol: string,
    assetClass: AssetClass,
    tags?: string[],
  ): Promise<void>;
  removeFromWatchlist(symbol: string): Promise<void>;
  getWatchlist(): Promise<WatchlistRow[]>;
}
```

Smart dispatcher: tries primary adapter first, falls back on rate limit or 5xx, deduplicates concurrent requests for the same symbol/interval, caches the last 24h of daily bars in-memory with TTL. Writes everything to `market_data`. Validates all responses via the H2 layer before persisting.

---

## Validation layer (H2 hardening)

**File:** `src/finance/validation.ts` (new)

Sanity checks on every bar before it lands in `market_data`:

```typescript
export function validateMarketBar(
  bar: RawMarketBar,
  context: ValidationContext,
): ValidationResult {
  // - Price sanity: low <= open, close <= high; volume >= 0; no NaN/Infinity
  // - Timestamp sanity: not in future, not before 1990-01-01
  // - Adjacency sanity: gap from previous bar matches interval (allow 1 missing bar for holidays)
  // - Price continuity: |close_n / close_n-1| within 10x (catches data glitches)
  // - Volume continuity: |vol_n / avg(vol_n-5..n-1)| within 100x (catches data glitches)
}
```

Returns `{ valid: boolean, reason?: string, corrupted?: boolean }`. Corrupted bars are rejected and logged to `api_call_budget.status='error'`. Missing bars (holidays, half-days) are gap-marked in metadata but inserted.

---

## Timezone normalization (H3 hardening)

**File:** `src/finance/timezone.ts` (new)

Every provider returns timestamps in a different format. F1 normalizes everything to `America/New_York` ISO 8601 strings **before insert**, because market rituals run on NYSE hours and every downstream indicator assumes NY time.

- Alpha Vantage returns `YYYY-MM-DD HH:MM:SS` in US/Eastern (intraday) or UTC (some endpoints). Normalize.
- Polygon returns UNIX ms UTC. Convert.
- FRED returns `YYYY-MM-DD` date-only (for macro series which are daily). Keep as date-only, don't add fake time.
- DST transitions: use the operator's stored TZ via `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })`, not manual offset math.

---

## Tools (6 new, all `deferred: true`)

All tools follow the v6.0 deferral pattern — they don't appear in the default tool catalog, only when scope activation triggers them.

| Tool                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `market_quote`            | Current snapshot for a symbol (live or last-close) |
| `market_history`          | Historical bars with date range + interval filter  |
| `market_watchlist_add`    | Add symbol to watchlist                            |
| `market_watchlist_remove` | Remove symbol from watchlist                       |
| `market_watchlist_list`   | List active watchlist                              |
| `market_budget_stats`     | Show Alpha Vantage + Polygon consumption vs limits |

Scope group `finance` is added to `src/messaging/scope.ts` with regex activation on natural-language patterns (Spanish + English): `/mercado|market|acci[oó]n|stock|ticker|bolsa|NYSE|NASDAQ|watchlist|cotiza|precio|SPY|\$[A-Z]{1,5}/i`.

---

## Tests (target: 40+ new)

**File:** `src/finance/*.test.ts`

- `alpha-vantage.test.ts` — 8 tests: mocked fetch, rate-limit retry, NEWS_SENTIMENT parsing, macro endpoint shape, cost_units tracking, error classification, timezone normalization
- `polygon.test.ts` — 6 tests: mocked fetch, 5 req/min local counter, backoff, shape compatibility with primary adapter, fallback trigger
- `fred.test.ts` — 4 tests: mocked fetch, series lookup, date range, error handling
- `data-layer.test.ts` — 10 tests: primary→fallback dispatch, concurrent request dedup, in-memory cache TTL, watchlist CRUD, market_data write path
- `validation.test.ts` — 8 tests: price sanity (each rule), timestamp sanity, continuity, gap detection
- `timezone.test.ts` — 6 tests: AV conversion, Polygon conversion, FRED date handling, DST transitions (spring forward, fall back), leap second (spec-compliant skip)
- `registry.test.ts` (MODIFY) — assert the 6 new tools are registered and `deferred: true`

**Expected count delta:** +42 tests, 2237 → ~2279.

---

## Verification steps

1. `npm run typecheck` — zero errors
2. `npm test` — all pass
3. Schema applied live via `sqlite3 ./data/mc.db < <ddl>` or automatic `initDatabase()` load
4. Smoke test adapter: `mc-ctl db "SELECT * FROM market_data WHERE symbol='SPY' ORDER BY timestamp DESC LIMIT 10"` — should return 10 recent daily bars of SPY after adapter fires once
5. Budget check: `mc-ctl db "SELECT provider, COUNT(*), SUM(cost_units) FROM api_call_budget GROUP BY provider"` — confirms AV usage tracked
6. Watchlist smoke: `mc-ctl` or direct CLI — add SPY, QQQ, AAPL, GOOGL, MSFT, confirm they appear
7. Fallback smoke: temporarily block Alpha Vantage (invalid API key), confirm Polygon serves the same `getDaily(SPY)` call
8. Live WhatsApp test: "Jarvis, ¿cómo está SPY?" → scope activates `finance` → `market_quote` fires → reply with current price

---

## Implementation order (single session, ~1.7x time)

1. Schema DDL + apply live (~15 min)
2. Types + `MarketBar`, `MacroPoint`, `WatchlistRow` interfaces (~15 min)
3. `timezone.ts` + tests (~30 min) — foundation for everything else
4. `validation.ts` + tests (~45 min)
5. `FredAdapter` + tests (~30 min) — simplest, warms up the adapter pattern
6. `AlphaVantageAdapter` + tests (~90 min) — biggest piece
7. `PolygonAdapter` + tests (~60 min) — mirrors AV shape
8. `DataLayer` facade + tests (~60 min) — dispatch + cache + fallback
9. 6 tools in `src/tools/builtin/` + scope wiring + `registry.test.ts` update (~45 min)
10. Smoke tests via mc-ctl (~15 min)
11. Live WhatsApp test + fix anything brittle (~30 min)
12. Commit + push (~10 min)

**Estimated total: ~7 hours of focused work ≈ 1.7 sessions.**

---

## Risks + mitigations

| Risk                                                         | Mitigation                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Alpha Vantage endpoint changes shape mid-implementation      | Adapters do strict zod parsing on responses; reject on parse fail                                                             |
| Polygon free tier 5 req/min isn't enough for fallback bursts | Pre-cache daily bars at 08:00 ET; fallback only fires for rare intraday queries                                               |
| Timezone bugs in DST weeks                                   | Explicit DST tests + `Intl.DateTimeFormat` not manual offset math                                                             |
| Budget tracking table grows unbounded                        | `rituals/scheduler.ts` nightly prune of `api_call_budget` rows older than 30 days                                             |
| Watchlist bloats beyond AV tier quota                        | `api_call_budget` enforced in `DataLayer` — refuses new symbol adds that push projected daily consumption > 80% of tier quota |
| F1 blocks on an operator-facing decision mid-session         | Three decisions locked BEFORE coding starts (Alpha Vantage tier, fallback source, watchlist scope)                            |

---

## Scope EXCLUSIONS (explicitly not in F1)

- ❌ Indicator calculations (→ F2)
- ❌ Signal detection (→ F3)
- ❌ Macro regime classification (→ F5)
- ❌ Prediction markets, whales, sentiment (→ F6, F6.5)
- ❌ Alpha combination engine (→ F7)
- ❌ Backtesting (→ F7.5)
- ❌ Paper trading (→ F8)
- ❌ Scan rituals (→ F9)
- ❌ Real-time crypto WebSocket (→ F10, optional)
- ❌ Charts (→ v7.1)
- ❌ Vision chart patterns (→ v7.1)

F1 is **just the data layer**. Everything else reads from the schema F1 creates.

---

## Open questions (for operator before final pre-plan)

1. **Alpha Vantage budget** — approve $49.99/mo?
2. **Polygon.io as fallback** — approve? Or prefer IEX Cloud paid for SLA?
3. **Initial watchlist** — which 20-30 symbols? (Default suggestion: SPY, QQQ, DIA, IWM, VXX, GLD, TLT, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, JPM, BAC, XLF, XLE, XLK, XLV + FX: EURUSD, USDJPY, GBPUSD, + macro: FEDFUNDS, CPI, NONFARM, VIXCLS)
4. **Macro series scope** — which FRED + AV macro series? Same as above list, or narrower?
5. **Live smoke test venue** — WhatsApp? Telegram? mc-ctl? All three?
6. **Rollout strategy** — schema additive so it can apply live. F1 ships as a single commit or split into 2-3 staged commits (schema → adapters → tools)?
