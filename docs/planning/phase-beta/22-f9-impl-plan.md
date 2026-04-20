# F9 Morning/EOD Scan Rituals — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S12 of β — the final β item. After F9 ships the β-addendum (F8.1a + F8.1b) is next, then γ.
> **Scope:** Two new daily rituals (`market-morning-scan` + `market-eod-scan`), market calendar (NYSE holidays + half-days), dynamic alert budget. Glues F1/F3/F5/F7/F7.5/F8 into a daily operator loop.
> **Branch:** `phase-beta/f9-rituals`.
> **Upstream:** `21-f8-impl-plan.md`, `feedback_f8_paper_trading.md`, `feedback_phase_beta_5sprint_day.md` (22-step cadence), `feedback_audit_iteration.md` (2-round audit budget).

---

## 1. Scope

**In (shipped this sprint):**

- `src/finance/market-calendar.ts` — NYSE 2024–2027 holiday dates + half-day dates; `isNyseTradingDay(date)` + `isEarlyClose(date)` + `nextTradingDay(date)` helpers. Timezone: America/New_York.
- `src/rituals/market-morning-scan.ts` — pre-market daily ritual (weekdays + NYSE-open gate): macro regime → alpha_latest → backtest_latest → paper_portfolio mark-to-market → deliver summary via Telegram
- `src/rituals/market-eod-scan.ts` — post-close daily ritual (weekdays + NYSE-close gate): day's close summary → paper P&L delta → next-day setup → Telegram. On Fridays: flag that weekly rebalance is due (operator triggers manually).
- `src/rituals/alert-budget.ts` — daily token/cost tracker. Checks pre-ritual whether budget exhausted; degrades gracefully to headline-only summary if so. Resets at midnight NY time.
- New `alert_budget` table — 1 row per day per ritual-id for consumption tracking
- 2 new read tools: `market_calendar` (is today trading?) + `alert_budget_status` (remaining budget today)
- New `market_ritual` scope group with ES+EN activation regex
- 2 new ritual registrations in `src/rituals/config.ts` (cron-scheduled via node-cron)
- Integration into existing scheduler via `executeRitual` dispatch table

**Out (deferred with explicit triggers):**

- **Auto-rebalance on green ship_gate** — Deferred to F9.1 if operator wants. Current F8 `paper_rebalance` refuses when `ship_blocked=1`, and F7.5 currently blocks on the seeded data. Auto-firing a rebalance from a ritual requires explicit operator opt-in per rebalance via override_ship_gate; keeping this manual in v1 matches the principle "F7.5 exists to gate F8; ritual exists to surface intelligence, not to trade".
- **News ingestion pipeline** — Uses existing `intel_query` from the signal-intelligence ritual. New sources deferred to γ.
- **Multi-venue ritual coverage** — F8.1b concern (adds Polymarket positions to the EOD recap once the adapter ships).
- **Multi-user personalization / per-user budgets** — v1 is single-operator (hardcoded `fede@eurekamd.net` via the existing morning-briefing pattern).
- **Intraday alerts** — weekly-first lock holds; intraday is F10's concern.
- **Alert-budget cost metering** — v1 tracks token counts only. USD cost attribution is a follow-up once LLM-provider price-per-token data is surfaced.

---

## 2. Design decisions resolved upfront

### D-A. Rituals are _scans_, not _traders_

Both rituals are READ-ONLY with respect to the paper portfolio. They read `paper_portfolio` / `paper_history` / `alpha_latest` / `backtest_latest` / `market_signals` / `macro_regime` and emit a summary. They DO NOT call `paper_rebalance`. That keeps F7.5's firewall load-bearing — the only path to actual paper trades is operator-triggered `paper_rebalance`, never a scheduled job.

**Why**: two failure modes to avoid. (1) ritual auto-fires a rebalance on a silently-degenerate alpha state → portfolio drifts without operator review. (2) operator muscle memory assumes "the ritual traded for me" when ship_gate silently blocked → confusion. Keeping rituals informational preserves the explicit-action invariant.

### D-B. Morning vs EOD cadence

- **Morning scan**: cron `0 8 * * 1-5` America/New_York (8:00 AM ET weekdays). Fires 1.5h before NYSE open.
- **EOD scan**: cron `30 16 * * 1-5` America/New_York (4:30 PM ET weekdays). Fires 30 min after close.
- Both gated by `market-calendar.isNyseTradingDay(today)`: skip holidays. Early-close days (e.g., day before July 4): morning scan fires normally; EOD scan shifts to `30 13` (1:30 PM ET).

**Why separate morning + EOD**: different audiences for different data. Morning = "what am I walking into" (macro regime + overnight news + positions MTM). EOD = "what happened today + prep for tomorrow". Combining into one call dilutes both.

### D-C. Friday special-case for EOD

EOD scan on Fridays appends a "💼 Fin de semana — rebalanceo de cartera" section that:

- Reads `backtest_latest("flam")` ship_gate status
- If `ship_blocked=0`: "Ship-gate OK. Run `paper_rebalance` to execute weekly rotation."
- If `ship_blocked=1`: Lists the blocked reason (PBO / DSR_pvalue) + cites override path.
- Does NOT auto-trigger rebalance (per D-A).

**Why**: the operator's weekly-first lock means Fridays are the natural decision point. EOD scan on Fridays must surface whether a rebalance is clean-to-execute, then step aside.

### D-D. Alert budget: token-count default, graceful degradation

Each ritual consumes a daily budget:

- Morning scan: 10k tokens default (LLM call + summary)
- EOD scan: 8k tokens default
- Overflow: if `remainingBudget < projected_consumption`, emit a one-line "⚠️ Alert budget exhausted" message instead of the full ritual, and schedule no more for that day.
- Reset at midnight America/New_York.

Budget is per-ritual-id + per-day. `alert_budget_status` tool returns `{ date, ritual_id, consumed, remaining }`.

**Why token-count v1, USD later**: token counts are immediately available from LLM responses. USD cost attribution requires per-model price mapping that changes per provider release; not worth hardcoding now. Token cap protects against a runaway loop (e.g., ritual chains 100 tool calls) without requiring the cost-accounting precision.

### D-E. Delivery: Telegram + email combo

- Morning scan: Telegram message (quick scan at breakfast) + email copy (searchable record)
- EOD scan: Telegram only (keeps inbox clean)
- Uses existing `telegram_send` and `gmail_send` tools. No new messaging infra.

**Why**: matches operator's existing flow per the morning-briefing ritual. No need to re-invent delivery.

### D-F. Market calendar — hardcoded holidays, no external API

NYSE holidays change rarely. A hardcoded array for 2024–2027 covers v7.0's horizon. Each entry: `{ date: "2026-05-25", reason: "Memorial Day", early_close: false }`. Update annually as part of a ritual review.

**Why no API**: external calendar APIs add a dependency + network flakiness at the most timing-sensitive moment (market open). Hardcoded data is checked in, testable, and version-controlled. Trade-off: NYSE adds a holiday (rare) → we notice via a miss + patch.

### D-G. Schema — 1 new table

```sql
CREATE TABLE IF NOT EXISTS alert_budget (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,                              -- ISO YYYY-MM-DD in America/New_York
  ritual_id       TEXT NOT NULL,                              -- 'market-morning-scan' | 'market-eod-scan' | ...
  tokens_consumed INTEGER NOT NULL DEFAULT 0,
  tokens_limit    INTEGER NOT NULL,
  exhausted_at    TEXT,                                       -- ISO timestamp when budget hit
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, ritual_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_budget_date ON alert_budget(date DESC);
```

Additive, live-applicable via `sqlite3 data/mc.db < schema.sql`.

### D-H. No new dependencies

All 6 new files use existing infra (`node-cron`, `better-sqlite3`, existing LLM adapter, existing messaging). Zero new deps.

---

## 3. Module contracts

### 3.1 `market-calendar.ts` — pure

```ts
export interface NyseHoliday {
  date: string; // ISO YYYY-MM-DD in NY time
  reason: string;
  earlyClose: boolean; // true = market closes 13:00 ET
}

export const NYSE_HOLIDAYS_2024_2027: readonly NyseHoliday[];

export function isNyseTradingDay(date: Date | string): boolean;
export function isEarlyClose(date: Date | string): boolean;
export function nextTradingDay(date: Date | string): string; // returns YYYY-MM-DD
export function prevTradingDay(date: Date | string): string;
```

Weekends always return false. Date input auto-normalizes to NY date by slicing with `toLocaleDateString("en-CA", { timeZone: "America/New_York" })`.

### 3.2 `alert-budget.ts` — DB-backed

```ts
export interface BudgetStatus {
  date: string; // YYYY-MM-DD NY
  ritualId: string;
  consumed: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

export const DEFAULT_LIMITS: Record<string, number>;

export function initBudget(ritualId: string, date?: string): BudgetStatus;
export function consumeBudget(
  ritualId: string,
  tokens: number,
  date?: string,
): BudgetStatus;
export function getBudgetStatus(ritualId: string, date?: string): BudgetStatus;
export function resetBudgetForDate(date: string): void; // admin helper
```

All reads/writes use the singleton `getDatabase()`. Date parameter defaults to "today in NY". First consumption of the day inserts a row; subsequent calls update.

### 3.3 `market-morning-scan.ts` — ritual template

Follows the existing `createMorningBriefing` pattern. Returns a `TaskSubmission` with:

- Title: `Market morning scan — ${dateLabel}`
- Agent type: fast
- Tools allowlist: macro_regime, alpha_latest, backtest_latest, market_signals, market_indicators, paper_portfolio, intel_query, telegram_send, gmail_send, market_calendar, alert_budget_status
- Required tools: paper_portfolio, telegram_send
- Prompt instructs LLM to:
  1. Check `market_calendar` → confirm today is a trading day (exit early if not)
  2. Check `alert_budget_status` → degrade to headline-only if exhausted
  3. Read `macro_regime` → regime label + confidence
  4. Read `alpha_latest` → top 5 weights + N_effective
  5. Read `backtest_latest` → ship_gate status
  6. Read `paper_portfolio` → current positions + total equity + yesterday-to-today MTM delta
  7. Read `intel_query(hours=14)` → overnight signals + macro events
  8. Compose Telegram message in ES (Mexican) matching existing morning-briefing tone
  9. Compose email version with headers + richer body
  10. Call `gmail_send` + `telegram_send`

### 3.4 `market-eod-scan.ts` — ritual template

- Title: `Market EOD scan — ${dateLabel}`
- Tools allowlist: macro_regime, alpha_latest, backtest_latest, market_signals, market_history, paper_portfolio, paper_history, intel_query, telegram_send, market_calendar, alert_budget_status
- Required tools: paper_portfolio, telegram_send
- Prompt flow:
  1. Trading-day + budget gates
  2. Read `market_history(SPY, lookback=5)` → close + %Δ for context
  3. Read `paper_portfolio` → today's mark + unrealized P&L
  4. Read `paper_history(since=today_start)` → today's fills (will be empty unless Friday rebalance fired)
  5. Read `intel_query(hours=6)` → afternoon news / signal firings
  6. If Friday: append weekly-rebalance section from `backtest_latest`
  7. Compose ES recap + post to Telegram

### 3.5 Tool handlers

`market_calendar`:

- Params: `{ date?: string }` (default today)
- Returns pre-formatted: `market_calendar: date=2026-04-20 trading=true early_close=false next_trading=2026-04-21`
- Deferred, read-only

`alert_budget_status`:

- Params: `{ ritual_id?: string; date?: string }` (default today + both rituals)
- Returns pre-formatted: `alert_budget: date=2026-04-20 morning=3200/10000 eod=0/8000`
- Deferred, read-only

---

## 4. Schema migration

Additive only. Append `alert_budget` DDL to `src/db/schema.sql`. Apply live.

---

## 5. Implementation order (22-step cadence)

1. Plan doc (this file).
2. Schema migration — 1 new table; live-applied.
3. `market-calendar.ts` + tests. Smallest, purely functional unit.
4. `alert-budget.ts` + tests. DB helpers.
5. `market-morning-scan.ts` template.
6. `market-eod-scan.ts` template.
7. Tool handlers `market_calendar` + `alert_budget_status` + tests.
8. Integration wiring:
   - `rituals/config.ts` — add 2 new ritual entries with cron schedules
   - `rituals/scheduler.ts` — add 2 cases to `executeRitual` switch
   - `tools/sources/builtin.ts` — register 2 new tools
   - `messaging/scope.ts` — new `market_ritual` scope group + regex + dispatch
   - `runners/fast-runner.ts` — both tools read-only (no WRITE_TOOLS additions)
   - `memory/auto-persist.ts` — add both tools to Rule 2b (read-only but large)
   - `runners/write-tools-sync.test.ts` — assert both read-only
9. `npm run typecheck` → zero errors
10. `npx vitest run` → ~2800 + ~40 new = ~2840 tests, all green
11. qa-auditor round 1 — expected classes: calendar off-by-one, budget race conditions, trading-day gate missed, ritual already-ran-today dedup broken
12. Fix round-1 findings
13. qa-auditor round 2
14. Fix round-2 findings
15. Build + deploy (`./scripts/deploy.sh`)
16. Live smoke — manually invoke both ritual templates via a scratch tsx script; verify Telegram delivery + budget row written + no duplicate runs
17. Docs — PROJECT-STATUS, V7-ROADMAP (S12 Done, β-addendum F8.1a next), EVOLUTION-LOG
18. Memory — `feedback_f9_rituals.md` + MEMORY.md index
19. Commit on `phase-beta/f9-rituals`
20. Push + PR + merge
21. Master V7-ROADMAP bump (11/12 Phase β done; F8.1a next per β-addendum)
22. Session wrap

---

## 6. Test strategy

| Layer                     | Tests                                                                                                                                                          | Count |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| market-calendar           | weekends = false, NYE 2026, Memorial Day 2026, Christmas 2024 = holiday, random Wed-not-holiday = true, early-close detection, nextTradingDay across weekend   | 10    |
| alert-budget              | first consume inserts row, repeat consumes accumulates, status below limit, status at/over limit, exhausted_at timestamp, reset helper, multi-ritual isolation | 10    |
| tool: market_calendar     | trading-day, weekend, holiday, early-close, malformed date                                                                                                     | 5     |
| tool: alert_budget_status | fresh day, partial consumption, exhausted, custom date, per-ritual filter                                                                                      | 6     |
| integration               | ritual templates build valid TaskSubmission with correct allowlist                                                                                             | 4     |
| scope                     | ES + EN activation, no false positives on generic "market"                                                                                                     | 6     |

Target: ~41 new tests. Baseline 2800 → ~2841.

---

## 7. Integration checklist (7 rows × 2 tools)

| Row                                                     | market_calendar | alert_budget_status |
| ------------------------------------------------------- | --------------- | ------------------- |
| Registered in `src/tools/sources/builtin.ts`            | ✓               | ✓                   |
| Scope group `market_ritual` in `src/messaging/scope.ts` | ✓               | ✓                   |
| Scope regex activates on NL prompt                      | ✓               | ✓                   |
| WRITE_TOOLS in fast-runner                              | — (read-only)   | — (read-only)       |
| write-tools-sync assertion (read-only)                  | ✓               | ✓                   |
| auto-persist Rule 2b                                    | — (lightweight) | — (lightweight)     |
| Handler test file                                       | ✓               | ✓                   |

14 touchpoints. Rituals themselves (as cron jobs) integrate via rituals/config.ts + rituals/scheduler.ts — not tool registrations, so separate wiring.

---

## 8. Risks & mitigations

| Risk                                                          | Likelihood | Impact | Mitigation                                                                                         |
| ------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Scheduler fires ritual on a holiday (calendar misses)         | Low        | Med    | `isNyseTradingDay` gate at ritual entry; test covers 2026 known holidays                           |
| Budget exhaustion mid-ritual → partial send, no warning       | Medium     | Low    | Budget checked BEFORE expensive LLM paths; degrade to headline-only cleanly                        |
| Cron timezone drift (America/Mexico_City vs America/New_York) | Medium     | Med    | Use America/New_York for market rituals (override the default RITUALS_TIMEZONE via cron.Config)    |
| Duplicate runs on VPS restart near schedule time              | Low        | Low    | Existing `alreadyRanToday` guard in scheduler                                                      |
| paper_portfolio empty → ritual emits confusing "no positions" | High       | Low    | Ritual prompt explicitly handles empty-portfolio case                                              |
| ship_gate status changes between morning + EOD on Friday      | Low        | Low    | Each ritual reads fresh `backtest_latest`; any operator-triggered backtest between them is honored |

---

## 9. Session wrap criteria

- [ ] `npm run typecheck` zero errors
- [ ] `npx vitest run` all green; test count 2800 → ~2841
- [ ] qa-auditor round 1 + 2 complete; Criticals closed or deferred with trigger
- [ ] Schema applied live; `alert_budget` table present
- [ ] Live smoke: manually invoke both ritual templates; verify Telegram delivery + budget row
- [ ] PROJECT-STATUS + V7-ROADMAP (S12 → Done) + EVOLUTION-LOG updated
- [ ] Memory `feedback_f9_rituals.md` written + indexed
- [ ] PR on `phase-beta/f9-rituals` merged to main

**With F9 merged**: Phase β closes on its original 12-item scope. β-addendum (F8.1a → F8.1b) queues for the next sprint before γ opens.

Target: one session, 2 audit passes, zero new deps.
