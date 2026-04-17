# F1 Data Layer — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S1 of β.
> **Status:** DRAFT — awaiting operator greenlight before coding.
> **Upstream:** `docs/planning/phase-beta/03-f1-preplan.md` (decisions locked 2026-04-14, credentials provisioned 2026-04-15).
> **Budget:** ~1.7 sessions (~7 hours focused work).
> **Branch:** `phase-beta/f1-data-layer` (off current main).

This plan operationalizes the preplan. Where the preplan stated "what and why", this plan states "files, functions, test names, commit order." Design decisions the preplan left open are surfaced and resolved at the top so they do not block mid-session.

---

## 1. Scope reminder (from preplan)

**In scope**: 6-table additive schema, AlphaVantage + Polygon + FRED adapters, DataLayer facade (cache + dispatch + fallback), H2 validation, H3 timezone normalization, api*call_budget tracking, 6 new tools (market_quote, market_history, market_watchlist*{add,remove,list}, market_budget_stats), `finance` scope group, 42 tests.

**Out of scope**: indicators (F2), signals (F3), macro regime classification (F5), prediction markets (F6), alpha combination (F7), backtesting (F7.5), paper trading (F8), rituals (F9), charts (v7.1).

---

## 2. Design decisions resolved before coding

Items the preplan left underspecified. Resolving these in the plan prevents mid-session stop-and-decide loops.

### D-A. Module location — `src/finance/` top-level (not under `src/intel/`)

`src/intel/adapters/` already holds `coingecko.ts`, `frankfurter.ts`, `treasury.ts` using the `CollectorAdapter` push-signal pattern (fire, hand signals to dashboard). F1 needs a **query + cache + dispatch** pattern — different access model, different consumer (indicator engine, not dashboard). Separate module avoids conflating the two. `src/finance/` is greenfield.

### D-B. Config key style — `optional()` on all three keys; adapter throws on missing

Per CLAUDE.md pattern `optional()` for non-required vars. Alpha Vantage / Polygon / FRED keys are **optional at boot** (Jarvis can start without finance), **required at first finance-tool call** (adapter constructor throws). Error surfaces to the user as "finance tools require ALPHAVANTAGE_API_KEY to be set" — not as a boot crash.

### D-C. DataLayer cache is L1 memory + L2 DB

Two-tier. Request for `getDaily(SPY, lookback=100)`:

1. Check in-memory Map keyed `daily:SPY:100` with 10-min TTL for intraday / 24h for daily.
2. Check `market_data` WHERE symbol='SPY' AND interval='daily' ORDER BY timestamp DESC LIMIT 100. If present and newest ≤ 24h old, return DB rows and populate L1.
3. Fetch from adapter, validate, insert to `market_data`, populate L1.

L1 is ephemeral; no persistence across restarts. Purely a request-dedup + hot-path accelerator.

### D-D. Rate-limit window is in-memory sliding; seeded from DB at boot

Alpha Vantage: ceiling 60 calls/min (80% of 75). Polygon: ceiling 4 calls/min (80% of 5). FRED: 100/min (ample).

Implementation: in-memory array of timestamps per provider. `canCall(provider)` returns true if last-60s count < ceiling. At boot, seed arrays from `SELECT call_time FROM api_call_budget WHERE call_time > datetime('now','-1 minute') AND provider=?` so restarts don't desync.

### D-E. Fallback policy on dispatch

In priority order:

1. Try AV. If success → return.
2. If AV rate-limited or 429/5xx → try Polygon with same query shape.
3. If Polygon also rate-limited → wait up to 30s for AV window to open, retry AV.
4. If Polygon 4xx (bad request, shape mismatch) → surface error, do NOT retry AV (query is the problem, not the provider).
5. If both fail terminally → return cached DB rows if any exist (even if stale), with `stale: true` flag. If no DB rows → throw `DataUnavailableError`.

Every attempt logged to `api_call_budget` with its status.

### D-F. Timezone contract

- **Storage**: `market_data.timestamp` is ISO 8601 in `America/New_York`. Examples: `2026-04-17T16:00:00-04:00` (EDT) or `2026-01-15T16:00:00-05:00` (EST).
- **Macro**: FRED series are date-only (daily cadence). Store as `YYYY-MM-DD` (no time component, no TZ). Downstream consumers treat as midnight NY.
- **Conversion**: `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', ... })` for date parts, manual offset derivation via `formatToParts`. Never manual arithmetic.
- **User-facing rituals**: F9 converts NY → CDMX for morning/EOD messages. F1 does not — storage is canonical NY.

### D-G. Symbol normalization

Single `normalizeSymbol(raw: string, assetClass: AssetClass): string`:

- `.trim().toUpperCase()`
- Equity/ETF: match `/^[A-Z][A-Z0-9.-]{0,9}$/`; reject otherwise
- FX: accept `EURUSD`, `EUR/USD`, `EUR-USD`, `eur_usd` → normalize to `EURUSD` (6 char, no separator)
- Macro: accept FRED/AV native names case-sensitive (`FEDFUNDS`, `CPI`, `VIXCLS`, `M2SL`, etc.) — throw on unknown
- Crypto: deferred (F10)

Rejection surfaces as `{ error: "Symbol 'xyz' is not valid. Use SPY, AAPL, EURUSD, or a macro series name like FEDFUNDS." }` — operator-friendly per D3.

### D-H. `market_data.provider` CHECK values

Keep the preplan's list verbatim: `('alpha_vantage','polygon','fmp','fred','manual')`. `fmp` is unused at F1 but reserved — CHECK constraint changes require `rm ./data/mc.db`, which we never do. Cheap future-proofing.

### D-I. Budget preview on watchlist add

Before INSERT to `watchlist`, compute projected daily AV calls for the new size. If >80% of tier quota (reference preplan: AV tier 1 = 108,000/day, 80% = 86,400), refuse the add with an explanatory error: "Adding LRCX would push projected daily AV usage to 85% of the 75/min tier ceiling. Upgrade or pick fewer symbols."

At 29 watchlist symbols and ~45 calls/morning-scan, projected daily is well under ceiling — this gate is a future-proof guard, not blocking at launch.

### D-J. Partial-fetch semantics

If AV returns fewer bars than requested (holiday, delisting, new listing), `DataLayer.getDaily` returns what it got and does NOT pad. Gap metadata is stored on the response envelope (`{bars: MarketBar[], gaps?: string[]}`). F2 (indicators) is expected to handle holes.

### D-K. Hostname switch for Polygon

Preplan locks `api.massive.com` as primary, `api.polygon.io` as legacy alias. Implementation: config var `POLYGON_BASE_URL` (default `https://api.massive.com/v2`). Rollback via env override.

### D-L. Tool description principles (ACI per CLAUDE.md)

Every tool:

- Zod schema with `.describe()` on EVERY field
- Enums for `asset_class`, `interval`
- Response shape pre-formatted for LLM consumption (not raw JSON dumps)
- Error messages actionable + Spanish-friendly

Example `market_watchlist_add`:

```typescript
z.object({
  symbol: z
    .string()
    .min(1)
    .max(15)
    .describe(
      "Ticker symbol. Equity/ETF: SPY, AAPL. FX: EURUSD. Macro series: FEDFUNDS, CPI, VIXCLS.",
    ),
  asset_class: z
    .enum(["equity", "etf", "fx", "commodity", "crypto", "macro"])
    .describe(
      "Asset class. Pick ETF for index funds (SPY, QQQ), equity for single stocks.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Optional grouping tags: sector, theme, regime-sensitivity. Used by F4 market tools for filtered scans.",
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Operator note, e.g. 'core position', 'hedge leg', 'high-conviction'.",
    ),
});
```

---

## 3. File manifest

| Path                                              | Action | Est. LOC | Purpose                                                                                    |
| ------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `src/db/schema.sql`                               | MODIFY | +100     | Append 6 tables + 6 indexes                                                                |
| `src/config.ts`                                   | MODIFY | +15      | Add 4 env-var plumbing entries                                                             |
| `src/finance/types.ts`                            | CREATE | ~80      | `MarketBar`, `MacroPoint`, `WatchlistRow`, enums                                           |
| `src/finance/timezone.ts`                         | CREATE | ~60      | NY normalization, DST-safe                                                                 |
| `src/finance/validation.ts`                       | CREATE | ~90      | `validateMarketBar`                                                                        |
| `src/finance/rate-limit.ts`                       | CREATE | ~70      | Sliding 60s per-provider counter                                                           |
| `src/finance/budget.ts`                           | CREATE | ~60      | api_call_budget write helper                                                               |
| `src/finance/adapters/alpha-vantage.ts`           | CREATE | ~220     | Daily, intraday, FX, macro, news, quote                                                    |
| `src/finance/adapters/polygon.ts`                 | CREATE | ~160     | Daily, intraday (AV shape-compatible)                                                      |
| `src/finance/adapters/fred.ts`                    | CREATE | ~80      | `fetchSeries`                                                                              |
| `src/finance/data-layer.ts`                       | CREATE | ~200     | Facade: dispatch + cache + persist                                                         |
| `src/tools/builtin/market-quote.ts`               | CREATE | ~60      | `market_quote` tool                                                                        |
| `src/tools/builtin/market-history.ts`             | CREATE | ~70      | `market_history` tool                                                                      |
| `src/tools/builtin/market-watchlist.ts`           | CREATE | ~140     | Add/remove/list watchlist tools                                                            |
| `src/tools/builtin/market-budget.ts`              | CREATE | ~40      | `market_budget_stats` tool                                                                 |
| `src/tools/sources/builtin.ts`                    | MODIFY | +10      | Register 6 new tools (deferred: true)                                                      |
| `src/inference/guards.ts`                         | MODIFY | +3       | market_quote, market_history, market_watchlist_list, market_budget_stats → READ_ONLY_TOOLS |
| `src/messaging/scope.ts`                          | MODIFY | +30      | `FINANCE_TOOLS` array + patterns + activation                                              |
| `src/memory/auto-persist.ts`                      | MODIFY | +5       | `market_history` to Rule 2b (content follow-up)                                            |
| `src/runners/write-tools-sync.test.ts`            | MODIFY | +6       | Add READ_ONLY finance tools                                                                |
| `src/finance/*.test.ts`                           | CREATE | ~800     | 42 tests across 7 test files                                                               |
| `src/finance/__fixtures__/av-daily-spy.json`      | CREATE | —        | Real AV response capture                                                                   |
| `src/finance/__fixtures__/polygon-daily-spy.json` | CREATE | —        | Real Polygon response capture                                                              |
| `src/finance/__fixtures__/fred-vixcls.json`       | CREATE | —        | Real FRED response capture                                                                 |
| `src/tools/registry.test.ts`                      | MODIFY | +10      | Assert 6 new tools + deferred:true                                                         |
| `src/messaging/scope.test.ts`                     | MODIFY | +15      | finance pattern activation cases                                                           |

**Totals**: 4 modified, 15 created, 3 fixtures. Estimated ~2400 LOC gross (~1600 production, ~800 tests).

---

## 4. Schema DDL (exact, append to `src/db/schema.sql`)

```sql
-- F1 Data Layer schema (v7.0 Phase β, S1) --------------------------------

CREATE TABLE IF NOT EXISTS market_data (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK(provider IN ('alpha_vantage','polygon','fmp','fred','manual')),
  interval        TEXT NOT NULL CHECK(interval IN ('1min','5min','15min','60min','daily','weekly','monthly')),
  timestamp       TEXT NOT NULL,
  open            REAL NOT NULL,
  high            REAL NOT NULL,
  low             REAL NOT NULL,
  close           REAL NOT NULL,
  volume          INTEGER NOT NULL,
  adjusted_close  REAL,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, provider, interval, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_market_data_symbol_ts ON market_data(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_data_interval ON market_data(interval, timestamp DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  symbol          TEXT PRIMARY KEY,
  name            TEXT,
  asset_class     TEXT NOT NULL CHECK(asset_class IN ('equity','etf','fx','commodity','crypto','macro')),
  tags            TEXT NOT NULL DEFAULT '[]',
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
  regime          TEXT,
  metadata        TEXT,
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
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_theses_symbol ON trade_theses(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_theses_outcome ON trade_theses(outcome);

CREATE TABLE IF NOT EXISTS api_call_budget (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,
  call_time       TEXT NOT NULL DEFAULT (datetime('now')),
  endpoint        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('success','rate_limited','error','timeout')),
  response_time_ms INTEGER,
  cost_units      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_budget_provider_time ON api_call_budget(provider, call_time DESC);

CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  signal_type     TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK(direction IN ('long','short','neutral')),
  strength        REAL NOT NULL,
  triggered_at    TEXT NOT NULL,
  indicators_snapshot TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals(symbol, triggered_at DESC);
```

Apply live after writing: `sqlite3 ./data/mc.db < src/db/schema.sql`. IF-NOT-EXISTS guarantees safe re-run.

---

## 5. Config diff (exact, add to `src/config.ts` Config interface + loader)

Interface field additions:

```typescript
  /** Alpha Vantage API key (finance primary). Optional at boot; required at first finance tool call. */
  alphaVantageApiKey?: string;
  /** Polygon.io / Massive API key (finance fallback). */
  polygonApiKey?: string;
  /** Polygon base URL (default https://api.massive.com/v2, legacy alias api.polygon.io). */
  polygonBaseUrl: string;
  /** FRED API key (macro series). */
  fredApiKey?: string;
```

Loader:

```typescript
    alphaVantageApiKey: optional("ALPHAVANTAGE_API_KEY"),
    polygonApiKey: optional("POLYGON_API_KEY"),
    polygonBaseUrl: process.env.POLYGON_BASE_URL ?? "https://api.massive.com/v2",
    fredApiKey: optional("FRED_API_KEY"),
```

Note env name exactly per F1 pre-plan D1: `ALPHAVANTAGE_API_KEY` (no underscore between ALPHA and VANTAGE).

---

## 6. Adapter surface contracts (`src/finance/types.ts`)

```typescript
export type AssetClass = "equity" | "etf" | "fx" | "commodity" | "crypto" | "macro";
export type Interval = "1min" | "5min" | "15min" | "60min" | "daily" | "weekly" | "monthly";
export type Provider = "alpha_vantage" | "polygon" | "fmp" | "fred" | "manual";

export interface MarketBar {
  symbol: string;
  timestamp: string;       // ISO 8601 America/New_York
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose?: number;
  provider: Provider;
  interval: Interval;
}

export interface MacroPoint {
  series: string;          // FEDFUNDS, VIXCLS, CPI, etc.
  date: string;            // YYYY-MM-DD (date-only)
  value: number;
  provider: Provider;
}

export interface WatchlistRow {
  symbol: string;
  name?: string;
  assetClass: AssetClass;
  tags: string[];
  active: boolean;
  addedAt: string;
  notes?: string;
}

export interface FetchResult<T> {
  bars: T[];
  gaps?: string[];         // ISO timestamps expected but missing
  stale?: boolean;         // served from DB cache because adapters unavailable
  provider: Provider;
}

export class RateLimitedError extends Error { readonly provider: Provider; ... }
export class DataUnavailableError extends Error { ... }
export class ValidationError extends Error { readonly bar: unknown; readonly reason: string; ... }
```

Adapter interface (shared contract):

```typescript
export interface MarketDataAdapter {
  readonly provider: Provider;
  fetchDaily(symbol: string, opts: { lookback: number }): Promise<MarketBar[]>;
  fetchIntraday(
    symbol: string,
    interval: Exclude<Interval, "daily" | "weekly" | "monthly">,
    opts: { lookback: number },
  ): Promise<MarketBar[]>;
  fetchFxDaily?(
    from: string,
    to: string,
    opts: { lookback: number },
  ): Promise<MarketBar[]>;
  fetchQuote?(symbol: string): Promise<MarketBar>;
  fetchMacro?(series: string): Promise<MacroPoint[]>;
}
```

Capability-based: AV implements all; Polygon omits `fetchFxDaily` and `fetchMacro` (not available on free tier); FRED implements only `fetchMacro` via a different interface (`MacroAdapter`).

---

## 7. DataLayer dispatch algorithm (`src/finance/data-layer.ts`)

```
getDaily(symbol, lookback):
  1. Cache L1 = dailyMemCache.get(`${symbol}:daily:${lookback}`)
     If present AND age < 24h → return L1.bars
  2. Cache L2 = DB query market_data WHERE symbol=? AND interval='daily' ORDER BY timestamp DESC LIMIT lookback
     If L2.length == lookback AND newestBar.fetched_at age < 24h → populate L1, return L2
  3. Adapter dispatch:
     a. If AV.canCall() → try AV.fetchDaily(symbol, lookback)
        On success: validate each bar, insert to market_data, log budget, populate L1+return
        On RateLimitedError → skip to (b)
        On other error → log + skip to (b) with reason
     b. If Polygon.canCall() → try Polygon.fetchDaily(symbol, lookback)
        Same validate/persist/cache flow
     c. If both unavailable:
        - If L2.length > 0 → return L2 with stale: true flag
        - Else → throw DataUnavailableError with both adapter errors
  4. In-flight dedup: if another caller already requested `${symbol}:daily:${lookback}`,
     both await the same Promise. Map<key, Promise<FetchResult<MarketBar>>>.
```

Same pattern for `getIntraday`, `getMacro`. `getQuote` short-circuits (AV GLOBAL_QUOTE, no Polygon fallback at F1 — F10 adds real-time).

---

## 8. Tool surface (6 tools, each `deferred: true`)

### market_quote

```typescript
z.object({
  symbol: z.string().describe("Ticker. Equity/ETF: SPY. FX: EURUSD."),
});
// Returns: "$SPY: $521.43 (+0.82%) as of 2026-04-17 15:59 ET (source: alpha_vantage)"
```

### market_history

```typescript
z.object({
  symbol: z.string(),
  interval: z
    .enum(["daily", "1min", "5min", "15min", "60min", "weekly", "monthly"])
    .default("daily"),
  lookback: z.number().int().min(1).max(500).default(100),
});
// Returns: pre-formatted text table with last N bars (date, O, H, L, C, V).
//          Rule 2b auto-persist so LLM can reference bars across turns.
```

### market_watchlist_add / remove / list

```typescript
// add: symbol, asset_class enum, tags?, notes?
// remove: symbol
// list: (no args) — returns pre-formatted table grouped by asset_class
```

### market_budget_stats

```typescript
// (no args) Returns: "Alpha Vantage: 342/108000 daily (0.3%), last hour 23 calls
//                     Polygon: 8 calls this minute (40% of 5/min)
//                     FRED: 12 calls today"
```

---

## 9. Scope wiring (`src/messaging/scope.ts`)

Three patterns, all `group: "finance"`:

```typescript
{
  // Symbol-pattern activation: "$SPY", "$AAPL"
  pattern: /\$[A-Z]{1,5}\b/,
  group: "finance",
},
{
  // Market verbs (ES+EN): mercado, ticker, bolsa, precio, stock, NYSE, NASDAQ, cotiza
  pattern: /\b(mercado|market|acci[oó]n|stock|ticker|bolsa|NYSE|NASDAQ|cotiza(?:ci[oó]n)?|precio\s+de)\b/i,
  group: "finance",
},
{
  // Watchlist CRUD verbs (operator D3 requirement)
  pattern: /\b(agrega|añade|quita|elimina|muestra|lista|add|remove|show|list)\b.{0,40}\b(watchlist|watch\s*list|ticker|symbol|s[ií]mbolo|acci[oó]n)\b/i,
  group: "finance",
},
```

`FINANCE_TOOLS = ["market_quote","market_history","market_watchlist_add","market_watchlist_remove","market_watchlist_list","market_budget_stats"]` — pushed into `tools` when `activeGroups.has("finance")`.

---

## 10. Test plan (42 tests across 7 files)

Per preplan §Tests. Test names specified so they land in predictable grep paths.

### `src/finance/timezone.test.ts` (6 tests)

- `normalizes Alpha Vantage US/Eastern intraday to NY ISO`
- `normalizes Polygon Unix ms UTC to NY ISO`
- `keeps FRED YYYY-MM-DD date-only`
- `handles DST spring-forward week (2026-03-08)`
- `handles DST fall-back week (2026-11-01)`
- `rejects timestamps pre-1990 and future-dated > 7 days`

### `src/finance/validation.test.ts` (8 tests)

- `accepts well-formed bar`
- `rejects low > open`, `rejects high < close`
- `rejects negative volume`, `rejects NaN price`, `rejects Infinity price`
- `rejects 15x price gap (continuity)`
- `flags 100x volume gap but accepts (logs warning)`

### `src/finance/fred.test.ts` (4 tests)

- `fetches VIXCLS series with date range`
- `handles 4xx API key error`
- `parses observation shape correctly`
- `rate-limit header respected (120/min)`

### `src/finance/adapters/alpha-vantage.test.ts` (8 tests)

- `fetches TIME_SERIES_DAILY_ADJUSTED`
- `fetches TIME_SERIES_INTRADAY (5min)`
- `fetches FX_DAILY (EURUSD)`
- `fetches GLOBAL_QUOTE`
- `fetches NEWS_SENTIMENT with cost_units=25`
- `fetches macro FEDERAL_FUNDS_RATE`
- `retries once on rate-limit response`
- `surfaces Alpha Vantage "Note: premium" as RateLimitedError`

### `src/finance/adapters/polygon.test.ts` (6 tests)

- `fetches daily aggregates from api.massive.com`
- `respects local 4/min sliding window`
- `exponential backoff on 429`
- `shape-compatible MarketBar with AV`
- `converts Unix ms to NY ISO`
- `honors POLYGON_BASE_URL override (legacy api.polygon.io)`

### `src/finance/data-layer.test.ts` (10 tests)

- `serves L1 cache on second identical call within TTL`
- `falls back to L2 DB when L1 expired but DB fresh`
- `fetches from adapter when both caches cold`
- `primary→fallback on AV rate-limited`
- `primary→fallback on AV 5xx`
- `both-unavailable returns stale DB rows with stale:true`
- `both-unavailable no DB rows throws DataUnavailableError`
- `in-flight dedup — two concurrent identical calls share one fetch`
- `addToWatchlist rejects on projected budget overflow`
- `addToWatchlist normalizes symbol case + asset_class validation`

### `registry.test.ts` MODIFY (+6 assertions, 1 test added)

- `all 6 finance tools registered with deferred:true`

### `scope.test.ts` MODIFY (+5 cases to existing test)

- `"$SPY cotiza?" activates finance`
- `"agrega TSLA a mi watchlist" activates finance`
- `"muestra mi watchlist" activates finance`
- `"cómo está el mercado" activates finance`
- `"buenos días" does NOT activate finance`

**Target: 2280 → 2322 tests (+42)**.

---

## 11. Integration checklist walkthrough

Per `docs/INTEGRATION-CHECKLIST.md`, for each new tool verify all 7 rows. F1 adds 6 tools.

| Integration point   | Coverage                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Handler          | `src/tools/builtin/market-*.ts` — one file per tool family                                                                |
| 2. Source register  | `src/tools/sources/builtin.ts` — import + add to both `allTools` and `tools()` in `registerTools()`                       |
| 3. Scope group      | `src/messaging/scope.ts` — `FINANCE_TOOLS` array + 3 patterns + activation block in `buildAvailableTools`                 |
| 4. READ_ONLY        | `src/inference/guards.ts` — market_quote, market_history, market_watchlist_list, market_budget_stats in `READ_ONLY_TOOLS` |
| 5. Rule 2b          | `src/memory/auto-persist.ts` — market_history output persisted for follow-up turns                                        |
| 6. write-tools-sync | `src/runners/write-tools-sync.test.ts` — add the 4 read-only finance tools to that group's READ_ONLY                      |
| 7. Test file        | `src/tools/builtin/market-*.test.ts` — mock `fetch`, happy + error paths                                                  |

Plus DB table + env var + scope group per their respective checklist sections.

Pre-commit grep sweep: `grep -rn "market_quote\|market_watchlist" src/` must return hits in items 1, 2, 3, 4, 5, 6, 7 (plus test files). If any integration row is missing, fix in the same commit.

---

## 12. Implementation order (single linear session, ~7h)

Each step ends with `npm run typecheck && npm test --run` passing before moving on.

| #   | Step                                                   | Time | Gate                                      |
| --- | ------------------------------------------------------ | ---- | ----------------------------------------- |
| 1   | Create branch `phase-beta/f1-data-layer` from main     | 2m   | clean tree                                |
| 2   | Schema DDL (§4) + apply live                           | 20m  | `mc-ctl db ".tables"` shows 6 new tables  |
| 3   | Config additions (§5)                                  | 10m  | typecheck green, startup boots            |
| 4   | `types.ts` — all shared interfaces + error classes     | 15m  | typecheck green                           |
| 5   | `timezone.ts` + 6 tests                                | 40m  | timezone tests green                      |
| 6   | `validation.ts` + 8 tests                              | 50m  | validation tests green                    |
| 7   | `budget.ts` + `rate-limit.ts` + basic tests            | 30m  | rate-limit sliding window works           |
| 8   | `fred.ts` adapter + 4 tests + fixture                  | 35m  | FRED tests green                          |
| 9   | `alpha-vantage.ts` adapter + 8 tests + fixture         | 90m  | AV tests green                            |
| 10  | `polygon.ts` adapter + 6 tests + fixture               | 60m  | Polygon tests green                       |
| 11  | `data-layer.ts` facade + 10 tests                      | 70m  | DataLayer tests green, in-flight dedup OK |
| 12  | 6 tool handlers in `src/tools/builtin/market-*.ts`     | 50m  | tool files compile, zod schemas parse     |
| 13  | `builtin.ts` + `guards.ts` + `auto-persist.ts` wiring  | 15m  | registry.test passes                      |
| 14  | `scope.ts` patterns + activation + 5 scope tests       | 25m  | scope tests green                         |
| 15  | `write-tools-sync.test.ts` update                      | 10m  | sync test green                           |
| 16  | `npm test` full run — all 2322 green, 0 type errors    | 15m  | fully green                               |
| 17  | Deploy: `./scripts/deploy.sh`                          | 5m   | service active                            |
| 18  | Smoke test 1: `mc-ctl db` checks (tables, budget rows) | 5m   | data persisted                            |
| 19  | Smoke test 2: live WhatsApp "¿cómo está SPY?"          | 10m  | scope activates, market_quote fires       |
| 20  | Smoke test 3: "Jarvis, agrega TSLA a mi watchlist"     | 10m  | D3 acceptance criterion met               |
| 21  | Self-audit via qa-auditor agent                        | 30m  | PASS or PASS WITH WARNINGS                |
| 22  | Commit + PR to main                                    | 15m  | PR open                                   |

Total: ~7 hours. Budget buffer: 1h for unexpected brittleness at step 9/10/11 (adapter edge cases).

---

## 13. Smoke-test plan (post-deploy)

Run in this exact order. Each step must pass before the next.

**Smoke 1: Schema present**

```bash
mc-ctl db ".tables" | grep -E "market_data|watchlist|api_call_budget|trade_theses|backtest_results|signals"
```

Expect: all 6 tables listed.

**Smoke 2: FRED end-to-end (simplest adapter)**

```bash
mc-ctl db "SELECT * FROM api_call_budget WHERE provider='fred'" # pre-run: 0 rows
# Trigger FRED call via a temporary test harness or mc-ctl test command
mc-ctl db "SELECT * FROM api_call_budget WHERE provider='fred'" # post-run: 1+ rows with status='success'
```

**Smoke 3: AV daily fetch**

```bash
# Via Node REPL or short test script:
# const dl = getDataLayer(); await dl.getDaily('SPY', {lookback: 30});
mc-ctl db "SELECT COUNT(*) FROM market_data WHERE symbol='SPY' AND provider='alpha_vantage'"
# Expect: ~30 rows
mc-ctl db "SELECT MIN(timestamp), MAX(timestamp) FROM market_data WHERE symbol='SPY'"
# Expect: NY ISO strings, most recent within last trading day
```

**Smoke 4: Fallback activation**

```bash
# Temporarily set ALPHAVANTAGE_API_KEY=invalid, restart
# Call getDaily('SPY') again — expect Polygon to serve it
mc-ctl db "SELECT provider, COUNT(*) FROM market_data WHERE symbol='SPY' GROUP BY provider"
# Expect: both alpha_vantage and polygon rows after this smoke
# Restore correct AV key, restart
```

**Smoke 5: WhatsApp NL — D3 acceptance**
Send from the operator's phone:

- "Jarvis, ¿cómo está SPY?" → scope activates finance → `market_quote` fires → reply with current price, change, timestamp
- "Jarvis, agrega TSLA a mi watchlist" → `market_watchlist_add` fires with symbol=TSLA, asset_class=equity → reply confirming
- "Muestra mi watchlist" → `market_watchlist_list` fires → pre-formatted response

If any of these three fail, F1 ships with a D3 violation. Block merge until fixed.

---

## 14. Risks + watchpoints

| Risk                                                    | Signal                               | Mitigation                                                 |
| ------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| AV intraday endpoint returns 403 premium gate           | Mid-session blocker                  | Tested 2026-04-11 — premium works; re-verify on day of     |
| Polygon "Massive" rename affects URL/auth               | 404/401 from `api.massive.com`       | Fall back to `POLYGON_BASE_URL=https://api.polygon.io/v2`  |
| DST-week bars land with +00:00 offset by mistake        | Bars with 0 UTC offset in DB         | timezone.test.ts DST cases catch at unit level             |
| AV rate limiter false-positive on 75/min burst          | Spurious `rate_limited` status rows  | Sliding window ceiling is 60 not 75 — conservative         |
| FRED key not yet activated                              | 403 on first call                    | Verified provisioned 2026-04-15; re-test at step 8         |
| Scope regex catches too much (e.g. "precio de la vida") | Unintended finance activation        | scope.test.ts has "buenos días" negative case + 5 patterns |
| Watchlist tool description too verbose → ACI failure    | LLM picks wrong tool                 | Keep at ~300 tokens, test with real model at step 19       |
| `market_data` grows large                               | DB at 169MB now, +1MB/month expected | Retention ritual deferred to F9; not an F1 concern         |

---

## 15. Acceptance criteria (ship-gate)

All must hold to merge:

- [ ] 2322 tests passing, 0 type errors
- [ ] 6 tables present and queryable via `mc-ctl db`
- [ ] `mc-ctl db "SELECT COUNT(*) FROM market_data"` > 0 after smoke 3
- [ ] 4 read-only tools confirmed in READ_ONLY_TOOLS (grep-verified)
- [ ] Scope `finance` activates for all 3 pattern families (scope.test.ts green)
- [ ] D3 smoke tests (watchlist CRUD via WhatsApp) pass end-to-end
- [ ] qa-auditor pass: PASS or PASS WITH WARNINGS (no CRITICAL)
- [ ] Integration checklist grep sweep: all 7 touchpoints covered
- [ ] CLAUDE.md not modified (no dep count changes — F1 adds zero deps)
- [ ] Post-merge: 12h observation window on main, no new failed runs attributable to F1

---

## 16. Post-F1 handoff

After F1 merges, the following become unblocked simultaneously (parallelizable per ordering-map Window A):

- **F2** (indicator engine) — reads `market_data.close`, `volume`; pure-math module
- **F4** (watchlist + market tools) — already has tools; adds `market_scan` cross-symbol
- **F5** (macro regime) — reads `market_data WHERE provider='fred'` + AV macro series

Per ordering-map S2-S3: bundle F2+F4 one session, F5+F3 next. Do not start F2 until F1 PR is merged.

---

## 17. Open questions for operator (before session start)

1. **Audit by qa-auditor required?** If yes, step 21 is mandatory. If no, ship at step 20.
2. **Live WhatsApp smoke test approval** — OK to send 3 test messages from operator phone during step 19-20?
3. **Session calendar** — start immediately, or target a specific time slot (e.g. after 2026-04-18 16:46 UTC readiness gate per V7-READINESS-CRITERIA)?

Once answered, F1 is a single-session commit.
