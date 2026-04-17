# F2 Indicator Engine + F4 Watchlist Tools — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S2 of β.
> **Scope:** F2 + F4 bundled per `04-ordering-map.md` Window A (both small, same schema reader, minimal coupling).
> **Status:** DRAFT — executes immediately post-F1 merge.
> **Branch:** `phase-beta/f2-f4-indicators-and-tools`.

F2 ships the pure-math indicator engine. F4 ships the two consumer tools that wrap F2's output into LLM-callable surfaces (`market_indicators`, `market_scan`). Three of F4's original tools (`market_quote`, `market_history`, `market_watchlist_{add,remove,list}`) already shipped in F1 — only `market_indicators` + `market_scan` remain here.

---

## 1. Scope

**In:**

- `src/finance/indicators.ts` — 9 pure-math indicators (SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR, ROC, Williams %R)
- `src/finance/indicators.test.ts` — 20+ tests, includes golden-file validation
- `src/finance/__fixtures__/indicators-golden.json` — captured input/output pairs from canonical sources (TradingView-style reference values)
- `src/tools/builtin/market.ts` extension — `marketIndicatorsTool`, `marketScanTool`
- Integration: `builtin.ts` register, `guards.ts` READ_ONLY, `scope.ts` `FINANCE_TOOLS` append, `market.test.ts` if created

**Out:**

- Signal detection (→ F3)
- Macro regime classification (→ F5)
- Indicator-layering vision prompt (→ v7.1)
- New indicators beyond the 9 specified (→ v7.x as needed)

---

## 2. Design decisions resolved upfront

### D-A. Pure functions, not a class

Every indicator is `function name(inputs): (number | null)[]`. Returns same-length array as input; leading elements are `null` when insufficient data to compute. No state, no side effects. Makes them trivially testable and composable.

### D-B. Wilder smoothing for RSI, SMA-initialization for EMA

Matches Alpha Vantage's server-side math + TradingView conventions.

- **RSI**: Wilder's RMA for avg gain / avg loss. First 14-period window uses SMA; subsequent periods use `new = (prev * (n-1) + current) / n`.
- **EMA**: First value = SMA of initial N bars (seeds the recursion), then `EMA(t) = α × price(t) + (1-α) × EMA(t-1)` where `α = 2 / (N+1)`.
- **MACD**: Composed from two EMAs (12 and 26) — same EMA semantics.

### D-C. Sample std dev for Bollinger, not population

Bollinger Bands convention: `n-1` divisor. Most charting libraries use sample std dev. Tests fix this by asserting specific values from a known-good fixture.

### D-D. VWAP is intraday-only — still ship but flag

VWAP (volume-weighted avg price) is resetting-daily by convention and only makes sense on intraday bars. Ship the function but:

- Tool description on `market_indicators` disables VWAP for `interval=daily`
- Unit test: computing VWAP on daily data returns values but it's the user's responsibility to know it's meaningless there

### D-E. Null-leading semantics

SMA(20) returns 19 nulls + 81 values for a 100-bar input. Callers ignore null prefix and consume the valid tail. The array length always equals input length — no off-by-one ambiguity.

### D-F. Float tolerance in tests

JS float math diverges from AV's server math by ~4–6 decimal places over long series. Test assertions use `toBeCloseTo(expected, 4)` — match to 4 decimal places, not exact. Flag any drift >1% as a bug in the implementation, not tolerance bounds.

### D-G. No AV server-side calls in tests

Preplan said "golden-file tests validated against Alpha Vantage server-side indicators." That's an acceptance-test concern for production. In unit tests, fixtures use **known-correct values from TradingView's docs or hand-computed-and-verified values**, not live AV calls (tests must be hermetic).

### D-H. `market_indicators` output shape — pre-formatted text

Per `feedback_preformat_over_prompt.md`, tools return pre-formatted text, not JSON. Shape:

```
SPY (daily, 100 bars) — latest values:
  SMA(20)     = 521.43
  EMA(20)     = 522.18
  RSI(14)     = 62.1  (neutral: 30-70)
  MACD(12,26,9) = 0.82, signal 0.55, hist 0.27 (bullish crossover)
  Bollinger(20,2) = upper 528.50, mid 521.43, lower 514.36
  ATR(14)     = 4.82
  ROC(10)     = +2.4%
  Williams %R(14) = -28.5 (neutral)
```

Caller LLM reads the summary directly — no post-parse needed.

### D-I. `market_scan` scope and budget

- Input: `{indicator, operator, threshold, tags?}` — e.g., "find symbols where RSI(14) < 30".
- Reads watchlist via DataLayer.listWatchlist, filters by tags if provided
- For each symbol, calls DataLayer.getDaily(symbol, {lookback: 30}) — this hits L2 cache after the first fetch of the day, so scan cost ≈ 0 AV calls when morning scan has already run
- Computes the indicator over the cached bars
- Returns formatted list of matches + summary stats

Rate-budget implication: even a cold scan across 29 symbols is 29 AV calls, well under the 60/min ceiling. Warm scan (hitting L2) is zero API calls.

### D-J. Operator enum, not free string

`operator` param on `market_scan`: `z.enum(["lt", "le", "gt", "ge", "eq"])`. Constrain LLM output space.

### D-K. Indicator naming canonical

On both tools, indicator names use a canonical lowercase slug:

- `sma`, `ema`, `rsi`, `macd`, `bollinger`, `vwap`, `atr`, `roc`, `williams`
- `market_indicators` accepts a list: `indicators: ["sma", "rsi", "macd"]` (default: all)
- `market_scan` accepts one indicator at a time (enum)

---

## 3. File manifest

| Path                                              | Action | LOC  | Purpose                                                    |
| ------------------------------------------------- | ------ | ---- | ---------------------------------------------------------- |
| `src/finance/indicators.ts`                       | CREATE | ~230 | 9 pure-math indicators                                     |
| `src/finance/indicators.test.ts`                  | CREATE | ~250 | ~20 tests incl. golden-file                                |
| `src/finance/__fixtures__/indicators-golden.json` | CREATE | —    | Known input/output pairs for validation                    |
| `src/tools/builtin/market.ts`                     | MODIFY | +180 | Append `marketIndicatorsTool`, `marketScanTool`            |
| `src/tools/sources/builtin.ts`                    | MODIFY | +4   | Import + register 2 new tools                              |
| `src/messaging/scope.ts`                          | MODIFY | +2   | Append `market_indicators`, `market_scan` to FINANCE_TOOLS |
| `src/inference/guards.ts`                         | MODIFY | +2   | Both new tools in READ_ONLY_TOOLS                          |
| (optional) `src/tools/builtin/market.test.ts`     | CREATE | ~100 | Tool-level integration tests (mocked DataLayer)            |

**Totals:** 2 modified, 3 created. ~500 LOC production + ~350 LOC tests. Zero new deps.

---

## 4. Indicator API (exact signatures)

```typescript
// src/finance/indicators.ts
export function sma(closes: number[], period: number): (number | null)[];
export function ema(closes: number[], period: number): (number | null)[];
export function rsi(closes: number[], period?: number): (number | null)[]; // default 14
export function macd(
  closes: number[],
  fast?: number, // 12
  slow?: number, // 26
  signal?: number, // 9
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
};
export function bollingerBands(
  closes: number[],
  period?: number, // 20
  stdDev?: number, // 2
): {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
};
export function vwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): (number | null)[];
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period?: number, // 14
): (number | null)[];
export function roc(closes: number[], period?: number): (number | null)[]; // default 10
export function williamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period?: number, // 14
): (number | null)[];

/** Latest non-null value of an indicator output. Utility for tools. */
export function latest(arr: (number | null)[]): number | null;
```

---

## 5. Test plan (20+ tests)

### Per-indicator tests (2 each, 18 total)

- **Happy path**: 30-bar input, hand-verified output at index -1 matches fixture to 4 decimals
- **Insufficient data**: input shorter than period returns all nulls

### MACD/Bollinger (1 extra each)

- MACD signal/histogram relationships: hist == macd − signal at every index
- Bollinger bands: upper ≥ middle ≥ lower at every non-null index

### Golden-file test (1)

- Load `__fixtures__/indicators-golden.json`, compute all 9 indicators on its input OHLCV, compare all outputs to 4 decimals

### Utility tests (2)

- `latest()` returns last non-null, returns null for all-null, handles empty array

**Target:** ~23 tests. Total 2323 → ~2346.

---

## 6. Tool ACI (exact shapes)

### `market_indicators`

```typescript
z.object({
  symbol: z.string().describe("Ticker. Equity/ETF: SPY, AAPL."),
  interval: z
    .enum(["daily", "1min", "5min", "15min", "60min"])
    .default("daily"),
  lookback: z.number().int().min(20).max(500).default(100),
  indicators: z
    .array(
      z.enum([
        "sma",
        "ema",
        "rsi",
        "macd",
        "bollinger",
        "vwap",
        "atr",
        "roc",
        "williams",
      ]),
    )
    .optional()
    .describe(
      "Which indicators to compute. Default: all. VWAP is meaningful on intraday intervals only.",
    ),
});
```

Output: pre-formatted summary (see D-H).

### `market_scan`

```typescript
z.object({
  indicator: z
    .enum(["sma", "ema", "rsi", "macd_hist", "roc", "williams"])
    .describe(
      "Single-value indicator to scan against. Excludes multi-output indicators like MACD full or Bollinger.",
    ),
  operator: z.enum(["lt", "le", "gt", "ge", "eq"]),
  threshold: z.number(),
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter watchlist by tags (match any)."),
  interval: z.enum(["daily", "60min"]).default("daily"),
  lookback: z.number().int().min(20).max(200).default(50),
});
```

Output:

```
market_scan: indicator=rsi operator=lt threshold=30 (watchlist: 29 symbols)
  Matches (3):
    TSLA: RSI(14) = 28.2
    META: RSI(14) = 29.1
    NVDA: RSI(14) = 29.9
  No match: 26 symbols
  Cache hits: 29/29 (zero new API calls)
```

---

## 7. Integration-checklist walkthrough

| Row | Action           | Where                                                         | Notes                                                          |
| --- | ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Handler          | `market.ts` — append `marketIndicatorsTool`, `marketScanTool` | Keep consolidated finance file                                 |
| 2   | Source register  | `builtin.ts` — import + add to `BUILTIN_TOOLS`                | Two entries                                                    |
| 3   | Scope            | `scope.ts` — append to `FINANCE_TOOLS`                        | Already have finance group from F1                             |
| 4   | READ_ONLY        | `guards.ts` — both tools added (neither writes state)         |                                                                |
| 5   | Rule 2b          | `auto-persist.ts` — NO change                                 | Output is compact, no content follow-up needed                 |
| 6   | write-tools-sync | `write-tools-sync.test.ts` — NO change                        | Both read-only, existing test covers via FINANCE_READ_ONLY set |
| 7   | Test file        | `indicators.test.ts` + optional `market.test.ts`              |                                                                |

---

## 8. Implementation order (~4–5h)

| #   | Step                                                                      | Time |
| --- | ------------------------------------------------------------------------- | ---- |
| 1   | Draft fixture JSON from known-good values (hand-computed or TV reference) | 30m  |
| 2   | `indicators.ts` — SMA, EMA first (foundation for MACD/RSI)                | 30m  |
| 3   | `indicators.ts` — RSI, MACD, Bollinger                                    | 40m  |
| 4   | `indicators.ts` — VWAP, ATR, ROC, Williams %R                             | 30m  |
| 5   | `indicators.ts` — `latest()` utility                                      | 5m   |
| 6   | `indicators.test.ts` — 20 tests                                           | 60m  |
| 7   | `market.ts` — `marketIndicatorsTool` + pre-format                         | 30m  |
| 8   | `market.ts` — `marketScanTool` + watchlist iteration                      | 30m  |
| 9   | Integration wiring (builtin.ts, scope.ts, guards.ts)                      | 10m  |
| 10  | Full typecheck + test suite                                               | 5m   |
| 11  | qa-auditor                                                                | 10m  |
| 12  | Fix audit findings                                                        | 30m  |
| 13  | Deploy + smoke                                                            | 15m  |
| 14  | Docs + memory + commit + PR                                               | 25m  |

**Total: ~5h. Matches 1 session (F2=1.0 + F4=1.0 compressed to 1 bundled session).**

---

## 9. Smoke test plan

1. `npm run typecheck` — zero errors
2. `npm test` — 2323 → ~2346 tests
3. Live: compute indicators on SPY
   ```bash
   node --env-file=.env -e '
     import("./dist/db/index.js").then(async (db) => {
       db.initDatabase("./data/mc.db");
       const { getDataLayer } = await import("./dist/finance/data-layer.js");
       const { rsi, sma } = await import("./dist/finance/indicators.js");
       const r = await getDataLayer().getDaily("SPY", { lookback: 50 });
       const closes = r.bars.map(b => b.close);
       console.log("RSI(14) latest:", rsi(closes).filter(Boolean).slice(-1)[0]);
       console.log("SMA(20) latest:", sma(closes, 20).filter(Boolean).slice(-1)[0]);
     })
   '
   ```
4. Live: invoke scan via mc-ctl or test harness (watchlist will be empty on fresh main, seed with 3-5 symbols first)

---

## 10. Risks

| Risk                              | Mitigation                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Golden-file precision drift       | 4-decimal tolerance; document why in test comments                                |
| VWAP misuse on daily              | Tool description disables; function returns values but docs warn                  |
| MACD signal-line divergence vs AV | Fixture includes AV-captured values; if mismatch >1%, investigate smoothing       |
| Scan fan-out hitting rate limit   | DataLayer L2 cache serves warm scans; 29 symbols ≈ under 60/min ceiling even cold |
| Empty watchlist on live scan      | Scan returns empty result with clear message, not error                           |

---

## 11. Acceptance criteria (ship-gate)

- [ ] ~23 new tests, all green
- [ ] 0 type errors
- [ ] qa-auditor PASS or PASS WITH WARNINGS (no CRITICAL)
- [ ] Live smoke: RSI + SMA computed on SPY data returned sensible values (RSI in [0,100], SMA near recent close)
- [ ] market_scan invokable via mc-ctl (empty watchlist → clear empty message)
- [ ] V7-ROADMAP F2 + F4 both marked Done
- [ ] Integration checklist all 7 rows covered per grep-sweep

---

## 12. Handoff to F5 / F3

After this PR merges, S3 from ordering-map (F5 + F3 together) is unblocked. F3 signal detector will consume:

- `detectSignals(data)` reads MarketBar[] and applies indicators from F2
- Signal patterns (ma_crossover, rsi_extreme, macd_cross, bollinger_breakout, volume_spike, price_threshold) compose the 9 indicators into boolean triggers
- `market_signals` tool uses the same DataLayer.getDaily + scan pattern as `market_scan` here
