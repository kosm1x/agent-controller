# F8 Paper Trading — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S11 of β — the prove-before-you-ship layer.
> **Scope:** TypeScript-native equity paper trader that consumes F7's weights + F7.5's ship_gate. `VenueAdapter` interface + `Clock` abstraction + PaperEquityAdapter as first concrete impl.
> **Branch:** `phase-beta/f8-paper-trading`.
> **Upstream:** `20-f7.5-impl-plan.md`, `feedback_f75_backtester.md`, `feedback_weekly_first_autoseed.md`, `V7-ROADMAP.md` §F8.
> **Upstream feedback:** `feedback_phase_beta_5sprint_day.md` (22-step cadence), `feedback_audit_iteration.md` (2-round audit budget).

---

## 0. Scope-shift flag (explicit)

The original V7-ROADMAP §F8 scope lists **pm-trader MCP server** as item 1 — a Polymarket-focused (prediction market) external MCP. That predates the 2026-04-18 operator lock to weekly-equity-only for F7/F7.5. Since F7 now produces **equity weights over 10 symbols × 520 weekly bars**, and F8 must paper-trade the output of F7.5, the center of gravity has moved from prediction markets to equities.

**This plan therefore re-scopes F8 to equity-first paper trading.** The architecture (VenueAdapter interface + Clock abstraction + shared execution engine) is designed exactly per the Nautilus research-to-live parity principle so that a future `PolymarketPaperAdapter` (pm-trader MCP wrapped) or a live `PolymarketLiveAdapter` can slot in without refactoring. pm-trader MCP integration is deferred to **F8.1** with a written trigger: "ship when a prediction-market alpha layer exists that produces Polymarket-positionable signals".

Everything else from §F8 (trade_theses, transaction costs, shadow portfolio, VenueAdapter, shared engine, Clock abstraction, research-to-live parity scaffolding) ships in this sprint.

---

## 1. Scope

**In (shipped this sprint):**

- `VenueAdapter` TS interface — shared domain model (`Order`, `Fill`, `Position`, `Balance`, `MarketQuote`)
- `Clock` abstraction — `WallClock` (paper default) + `FixedClock` (tests/future backtest replay)
- `PaperEquityAdapter` — first concrete impl; AV-backed market data, synthetic fills at close × slippage
- Execution engine — weekly rebalance loop: read F7 weights → check F7.5 ship_gate → diff against current portfolio → generate Orders → fill via adapter → persist fills
- 3 new tables: `paper_portfolio`, `paper_fills`, `paper_balance` (additive, live-applicable)
- Reuse existing `trade_theses` table (per-rebalance thesis snapshot, symbol-scoped)
- 3 new deferred tools: `paper_rebalance` (write), `paper_portfolio` (read), `paper_history` (read)
- New `paper` scope group with ES+EN regex
- Ship-gate enforcement: `paper_rebalance` refuses when F7.5 `ship_blocked=1` unless `override_ship_gate=true`
- Transaction cost model — 5bps slippage + commission (mirrors F7.5 default; configurable)
- Shadow portfolio semantic: default `'default'` account; multi-account reserved for F11

**Out (deferred with explicit triggers):**

- **pm-trader MCP integration** — F8.1 when a prediction-market alpha layer exists. The MCP server is production-ready (per `07-pm-trader-dryrun.md`); blocker is the signal→position bridge, not the execution adapter
- **Replication scoring (vs Polymarket whales)** — F8.1, same trigger
- **Research-to-live parity reconciliation test** — deferred to F11 when a live adapter exists to compare against. This sprint only ships the INTERFACES that make that test possible
- **Multi-account A/B testing** — F8.2. Schema leaves `account` column to keep forward-compat
- **Intraday rebalancing** — F10 (crypto WS); weekly lock holds
- **Margin / short-sell / options** — out of v1 v7.0 scope entirely
- **Tax-lot / wash-sale tracking** — compliance concern; F11 live-trading prerequisite, not F8
- **Order types beyond MARKET** — LIMIT/STOP are F8.2 if operator requests. v1 rebalance is notional-target, not price-sensitive

---

## 2. Design decisions resolved upfront

### D-A. Execution model: notional rebalance

At each rebalance, target `shares(symbol) = floor(portfolio_equity × weight(symbol) / last_price, 4dp)`. Diff vs current → generate MARKET orders for the delta. Buy-fill at `last_price × (1 + slip)`; sell-fill at `last_price × (1 - slip)`. Fractional shares allowed (4-decimal precision) to avoid rounding a 0.02 weight into a zero position.

**Why fractional**: with $100K × 0.02 weight = $2K and AAPL at $200, that's exactly 10 shares — no rounding issue — but with NVDA at $900, that's 2.22 shares. Fractional is realistic for modern brokers (Robinhood, Fidelity) and avoids discarding low-weight positions.

### D-B. Price source

Use F1's `DataLayer.getWeekly()` last close as the fill price. If the rebalance fires during a trading day with fresh data, use `market_quote` (AV real-time). If closes+quotes both missing for a symbol, that position errors the entire rebalance (no partial rebalance — atomicity beats best-effort).

**Why atomic**: partial rebalance leaves portfolio in an incoherent state mid-rotation. Better to error loudly and retry than commit half.

### D-C. Cash + initial equity

Start at **$100,000 cash** on first run (default account). On every buy, `cash -= gross_notional + commission`. On sell, `cash += gross_notional - commission`. Negative cash rejects the rebalance.

**Why $100K**: standard paper-trading convention; round number; enough to fit 10 symbols at realistic weights. Configurable via `override_initial_cash` param on first run only.

### D-D. Transaction cost model (v1)

- **Slippage**: 5 bps (same as F7.5 default). Applied as `price × (1 ± 5e-4)` per side.
- **Commission**: 0 bps (equity brokers are commission-free). Column kept for forward-compat.
- Both configurable per adapter construction (not per order — consistency within a rebalance).

**Why simple**: F7.5's backtest assumes 5 bps round-trip. F8 must match to avoid backtest-vs-paper divergence. Order-book-dependent slippage is F11 live concern.

### D-E. Ship-gate semantics

`paper_rebalance` reads `readLatestBacktest('flam')`:

- If no backtest run exists → error (operator must run `backtest_run` first).
- If `ship_blocked=1 AND override_ship_gate=false` → refuse with structured message citing PBO + DSR values.
- If `override_ship_gate=true` → proceed but mark the thesis row with `override=1` + log prominently.
- If `ship_blocked=0` → proceed.

**Why strict by default**: F7.5 exists to gate F8. Auto-override defeats the purpose. Operator override is a deliberate audit-trail event.

### D-F. Clock abstraction

```ts
export interface Clock {
  now(): Date;
}
export class WallClock implements Clock {
  now(): Date {
    return new Date();
  }
}
export class FixedClock implements Clock {
  constructor(private fixed: Date) {}
  now(): Date {
    return this.fixed;
  }
}
```

PaperEquityAdapter takes a `Clock` in its constructor; defaults to `new WallClock()`. Tests inject `FixedClock` for deterministic timestamps. Future backtest replay and live venue clock drop in without touching strategy code.

### D-G. VenueAdapter interface

```ts
export interface Order {
  clientOrderId: string; // UUID generated by caller
  symbol: string;
  side: "buy" | "sell";
  quantity: number; // fractional shares
  type: "market"; // v1 only
  timeInForce: "day"; // v1 only
}

export interface Fill {
  fillId: string; // UUID from adapter
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number; // fill price (post-slippage)
  grossNotional: number; // quantity × price
  commission: number;
  slippageBps: number;
  filledAt: string; // ISO 8601 (adapter clock)
}

export interface OrderReject {
  clientOrderId: string;
  reason: string; // e.g. "insufficient_cash", "no_quote"
  rejectedAt: string;
}

export interface Position {
  symbol: string;
  shares: number;
  avgCost: number; // weighted average entry
  marketValue: number; // shares × last_price (computed by adapter)
  unrealizedPnl: number; // marketValue − (shares × avgCost)
}

export interface Balance {
  cash: number;
  totalEquity: number; // cash + Σ positions.marketValue
  positionsValue: number;
}

export interface MarketQuote {
  symbol: string;
  price: number; // last / close
  asOf: string; // ISO 8601
  source: "weekly_close" | "intraday_quote" | "cache";
}

export interface VenueAdapter {
  readonly name: string; // "paper_equity" / "pm_trader" / "binance_live"
  readonly clock: Clock;
  getMarketData(symbol: string): Promise<MarketQuote>;
  placeOrder(order: Order): Promise<Fill | OrderReject>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  getFills(opts?: {
    since?: Date;
    symbol?: string;
    limit?: number;
  }): Promise<Fill[]>;
}
```

**Why minimal**: covers the surface needed for weekly rebalance. Order-book `getOrderBook()`, `cancelOrder`, LIMIT orders are F8.2 if needed. Keeping the v1 interface small preserves the parity invariant — every adapter must implement exactly these methods.

### D-H. Schema — 3 new tables

```sql
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
  shares          REAL NOT NULL,                 -- fractional allowed
  avg_cost        REAL NOT NULL,                 -- weighted avg entry
  opened_at       TEXT NOT NULL,                 -- first buy timestamp
  last_updated    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account, symbol)
);

CREATE TABLE IF NOT EXISTS paper_fills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id         TEXT NOT NULL UNIQUE,          -- UUID from adapter
  thesis_id       INTEGER,                       -- FK trade_theses.id
  account         TEXT NOT NULL DEFAULT 'default',
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  shares          REAL NOT NULL,
  fill_price      REAL NOT NULL,
  gross_notional  REAL NOT NULL,
  commission      REAL NOT NULL DEFAULT 0,
  slippage_bps    REAL NOT NULL DEFAULT 0,
  realized_pnl    REAL,                          -- non-null for sells
  filled_at       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_fills_account_time
  ON paper_fills(account, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_fills_symbol
  ON paper_fills(symbol, filled_at DESC);
```

Reuse existing `trade_theses` table. On each rebalance, INSERT one row with:

- `symbol = 'PORTFOLIO'` (sentinel for multi-symbol rebalances)
- `thesis_text = JSON{alpha_run_id, backtest_run_id, regime, override_ship}`
- `entry_signal = 'weekly_rebalance'`
- `metadata = JSON{target_weights, executed_fills_count, rejected_orders_count}`

**Why reuse**: `trade_theses` exists and its semantics fit. Adding another table duplicates purpose.

### D-I. Tool surface (3 new, all in `paper` scope)

| Tool              | Kind  | Purpose                                                                                           |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `paper_rebalance` | write | Run the full pipeline: alpha_run → check gate → fetch F1 prices → diff vs current → execute fills |
| `paper_portfolio` | read  | Current positions + cash + total equity + MTD/YTD return                                          |
| `paper_history`   | read  | Recent fills; filter by symbol + since                                                            |

`paper_rebalance` is a WRITE tool (WRITE_TOOLS set + write-tools-sync test + auto-persist Rule 2b).

### D-J. Rebalance trigger

Manual via `paper_rebalance` tool at v1. Cron scheduling (Sunday night NY) is v1.1 once the manual path is verified in production. Operator runs it weekly.

### D-K. Idempotency / weekly dedup

`paper_rebalance` checks whether a thesis row with `symbol='PORTFOLIO'` already exists for this ISO-week. If yes and `force=false`, return a no-op message. `force=true` creates a second row for the same week (rare).

---

## 3. Schema migration

Additive only. `sqlite3 ./data/mc.db < src/db/schema.sql` applies live. No reset.

---

## 4. Module contracts

### 4.1 `VenueAdapter` types — `src/finance/venue-types.ts`

Pure types file (see D-G). No implementation. No deps.

### 4.2 `Clock` — `src/finance/clock.ts`

`WallClock`, `FixedClock`. No deps.

### 4.3 `PaperEquityAdapter` — `src/finance/paper-equity-adapter.ts`

**Constructor**: `(opts: { clock?: Clock; costBps?: number; commissionBps?: number; dataLayer?: DataLayer; account?: string })`

**Methods** implement VenueAdapter:

- `getMarketData(symbol)` — `DataLayer.getWeekly(symbol, lookback=1)`; errors if no bars for 5 weeks (stale).
- `placeOrder(order)` — validate side/qty, fetch quote, compute fill price (with slippage), compute commission, INSERT paper_fills row, UPDATE paper_portfolio, UPDATE paper_balance cash. All in one DB transaction. Returns Fill or OrderReject.
- `getPositions()` — SELECT paper_portfolio WHERE account = 'default'; for each, fetch last price, compute marketValue + unrealizedPnl.
- `getBalance()` — SELECT paper_balance; cash + Σ marketValue across positions.
- `getFills(opts)` — SELECT paper_fills WHERE account = opts.account ORDER BY filled_at DESC [+ filters + limit].

**Invariants**:

- Negative cash after a buy → reject (don't commit).
- Sell quantity > held shares → reject (no shorting in v1).
- Pre-position-avg-cost reset on full exit: when shares reach 0, realized_pnl locked, row deleted.

### 4.4 Execution engine — `src/finance/paper-executor.ts`

`async function rebalance(opts: { adapter: VenueAdapter; targetWeights: Record<string, number>; overrideShipGate: boolean; alphaRunId: string; backtestRunId: string; regime: string | null })` — the orchestrator.

Steps:

1. Compute current equity from adapter.getBalance().
2. For each symbol in targetWeights ∪ current positions: compute target shares.
3. Diff → orders (side + qty).
4. Sort orders: sells first (free up cash), buys last.
5. Execute serially via adapter.placeOrder.
6. Collect fills + rejects.
7. INSERT thesis row (symbol='PORTFOLIO'; metadata with run ids, override, results).
8. Return structured summary: { fills, rejects, totalEquityBefore, totalEquityAfter, thesisId }.

Pure orchestration, no SQL directly. Tests inject a mock VenueAdapter.

### 4.5 Persistence — `src/finance/paper-persist.ts`

Just the schema-adjacent helpers: `initAccount`, `readPortfolio`, `readBalance`, `readFills`, `insertThesisPortfolio`. Invoked by the adapter.

### 4.6 Tool handlers — `src/tools/builtin/paper-trading.ts`

`paper_rebalance`: Zod `override_ship_gate?: boolean`, `force?: boolean`, `initial_cash?: number` (first-run only). Reads alpha_latest + backtest_latest, gates, constructs adapter + weights, calls executor, returns pre-formatted summary.

`paper_portfolio`: no params. Returns positions table + balance.

`paper_history`: `symbol?`, `since?`, `limit?` (default 20). Returns fills table.

---

## 5. Implementation order

22-step cadence, mirrors F7.5:

1. Plan doc review (this file).
2. Schema migration — 3 new tables added; live-applied.
3. `venue-types.ts` + `clock.ts` + tests (pure types; smallest unit).
4. `paper-persist.ts` + tests — basic read/write helpers with in-memory SQLite.
5. `paper-equity-adapter.ts` + tests — mock DataLayer, verify fill math + slippage + avg-cost weighted updates.
6. `paper-executor.ts` + tests — mock VenueAdapter, verify rebalance produces correct order diff + thesis row.
7. Tool handlers `paper-trading.ts` + tests — 3 tools × (happy path + edge cases).
8. Integration wiring — builtin.ts, scope (new `paper` group + regex), WRITE_TOOLS, write-tools-sync test, auto-persist Rule 2b.
9. `npm run typecheck` → zero errors.
10. `npx vitest run --reporter=dot` → 2728 + ~60 new = ~2790 tests.
11. qa-auditor round 1 — expect: ship-gate bypass, avg-cost reset bugs, cash-negative bugs, order-diff bugs.
12. Fix round-1 findings.
13. qa-auditor round 2.
14. Fix round-2.
15. Build + deploy (`./scripts/deploy.sh`).
16. Live smoke — override ship-gate (F7.5 is currently blocked), run one rebalance over seeded data, verify fills + portfolio rows.
17. Docs — PROJECT-STATUS, V7-ROADMAP (mark S11 Done, F9 next), EVOLUTION-LOG.
18. Memory — `feedback_f8_paper_trading.md` + MEMORY.md index.
19. Commit on `phase-beta/f8-paper-trading`.
20. Push + PR + merge.
21. Master V7-ROADMAP bump (10/12 Phase β done).
22. Session wrap.

---

## 6. Test strategy

| Layer         | Tests                                                                                             | Count |
| ------------- | ------------------------------------------------------------------------------------------------- | ----- |
| Clock         | WallClock now() present; FixedClock returns injected date                                         | 3     |
| venue-types   | type-level only; compile test asserting shape                                                     | 2     |
| paper-persist | init account, read empty, write fill + read, update cash, upsert portfolio row                    | 8     |
| paper-equity  | fill math (buy/sell, slippage, commission), insufficient-cash reject, short-sell reject, avg-cost | 12    |
| paper-exec    | empty portfolio first rebalance, diff with existing positions, ship-gate respect, override path   | 10    |
| tools         | 3 tools × (happy + blocked + missing-data + malformed args)                                       | 12    |
| integration   | end-to-end: seed schema + seed bars → rebalance against a gated F7.5 run with override            | 1     |
| scope         | `paper`, `paper_rebalance`, `portfolio`, `historial de papel`, ES+EN variants                     | 6     |
| write-sync    | `paper_rebalance` in WRITE_TOOLS; `paper_portfolio`/`paper_history` read-only                     | 3     |

Total new: ~57. Target: 2728 → ~2785.

---

## 7. Integration checklist (7 rows × 3 tools)

| Row                                                  | paper_rebalance | paper_portfolio | paper_history |
| ---------------------------------------------------- | --------------- | --------------- | ------------- |
| Registered in `src/tools/sources/builtin.ts`         | ✓               | ✓               | ✓             |
| Scope group `paper` in `src/messaging/scope.ts`      | ✓               | ✓               | ✓             |
| Scope regex activates on NL prompt                   | ✓               | ✓               | ✓             |
| WRITE_TOOLS Set in `src/runners/fast-runner.ts`      | ✓               | —               | —             |
| write-tools-sync test covers classification          | ✓               | ✓ (read_only)   | ✓ (read_only) |
| auto-persist Rule 2b in `src/memory/auto-persist.ts` | ✓               | —               | —             |
| Handler test file exists                             | ✓               | ✓               | ✓             |

21 touchpoints. Missing any = ship-blocker.

---

## 8. Tool descriptions (ACI)

### `paper_rebalance`

> Runs a weekly paper-trading rebalance: reads the latest F7 alpha weights and F7.5 ship_gate, refuses if `ship_blocked=1` unless `override_ship_gate=true`, diffs the target portfolio against current holdings, executes MARKET fills at last weekly close × 5 bps slippage, persists fills + thesis. Takes ~1-2 seconds. Starts a default account with $100,000 cash on first run.
>
> USE WHEN: operator asks to paper-trade, rebalance, execute the strategy, "ejecuta el paper trade", "pon el portafolio", "rotar posiciones", "rebalancear la cartera".
> NOT WHEN: asking for just the current positions (use `paper_portfolio`) or for the last fills (use `paper_history`). Do NOT use for Polymarket / prediction-market trading — that's F8.1.

### `paper_portfolio`

> Returns the current paper-trading portfolio: positions (symbol + shares + avg_cost + market_value + unrealized P&L), cash, total equity, cumulative return. Read-only, no side effects.

### `paper_history`

> Returns recent paper-trading fills. Filter by `symbol` or `since` (ISO date); default limit 20. Read-only.

---

## 9. Deferrals with triggers

| Deferred                                   | Trigger to revisit                                         |
| ------------------------------------------ | ---------------------------------------------------------- |
| pm-trader MCP integration (Polymarket)     | Ship when prediction-market alpha layer exists             |
| Replication scoring (vs Polymarket whales) | Same trigger as pm-trader                                  |
| Research-to-live parity test               | F11 ships live adapter — need both sides to reconcile      |
| Multi-account A/B testing                  | Operator requests side-by-side strategy variant comparison |
| LIMIT / STOP order types                   | Operator requests price-sensitive entries                  |
| Intraday rebalancing                       | F10 (crypto WS) ships; weekly-lock lifted                  |
| Tax-lot / wash-sale tracking               | F11 live-trading prerequisite                              |
| Cron-scheduled auto-rebalance              | F9 ritual session (integrates this tool)                   |

---

## 10. Risks & mitigations

| Risk                                                  | Likelihood | Impact | Mitigation                                                             |
| ----------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------- |
| Rebalance against outdated F7 alpha (stale run_id)    | Medium     | Medium | Warn if alpha_latest > 7 days old; error if > 30 days                  |
| Stale price data → wrong fill price                   | Low        | High   | Error if getWeekly last bar > 5 weeks old for the symbol               |
| Ship-gate bypass via casual override                  | Medium     | High   | `override_ship_gate=true` is logged prominently; thesis row marks it   |
| F7.5 `ship_blocked=1` permanently (dev can't test)    | High       | High   | Plan includes override path; live smoke uses it explicitly             |
| Avg-cost math drift (buying when already long)        | Medium     | Medium | Weighted-average formula unit-tested against hand-computed fixtures    |
| Cash going negative from concurrent rebalances        | Low        | Medium | Adapter uses `db.transaction()`; single account = serialized by SQLite |
| Schema duplicate fill_id                              | Low        | Low    | `fill_id UNIQUE` constraint; UUIDs collision-free                      |
| Weekly dedup false-positive (already-rebalanced week) | Medium     | Low    | `force=true` flag to override                                          |

---

## 11. Session wrap criteria

- [ ] `npm run typecheck` zero errors
- [ ] `npx vitest run` all green; test count 2728 → ~2785
- [ ] qa-auditor round 1 + 2 complete; Criticals closed or deferred with written trigger
- [ ] Schema applied live; 3 new tables present; existing `trade_theses` untouched
- [ ] Live smoke: `paper_rebalance` with `override_ship_gate=true` over seeded data produces ≥1 fill, positions persisted, thesis row written
- [ ] PROJECT-STATUS, V7-ROADMAP (S11 → Done, S12 F9 next), EVOLUTION-LOG updated
- [ ] Memory `feedback_f8_paper_trading.md` written + indexed in MEMORY.md
- [ ] PR on `phase-beta/f8-paper-trading` merged to main

Target: one session, 2 audit passes, zero new deps.
