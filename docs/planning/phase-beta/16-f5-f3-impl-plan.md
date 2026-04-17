# F5 Macro Regime + F3 Signal Detector — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S3 of β.
> **Scope:** F5 + F3 bundled per `04-ordering-map.md` Window B. F5 is a pure macro transform, F3 is a pure price-pattern transform; both consume F1 data layer outputs and F2 indicators.
> **Branch:** `phase-beta/f5-f3-macro-and-signals`.

F5 ships the macro-regime classifier (rules-based on FRED+AV macro series). F3 ships the signal detector (6 pattern types over OHLCV bars) + `market_signals` tool + signal persistence to the `market_signals` DB table F1 pre-allocated. Together they complete the signal-layer foundation F7 needs.

---

## 1. Scope

**In:**

- `src/finance/macro.ts` — `classifyRegime(macroSeries)` + `latestMacroValue` + YoY/slope helpers, plus a `MacroRegime` type
- `src/finance/macro.test.ts` — ~14 tests covering all 4 regime rules + edge cases
- `src/finance/signals.ts` — 6 pure signal detectors + aggregator; persists to `market_signals` via `persistSignal`
- `src/finance/signals.test.ts` — ~22 tests: happy path + boundary + composite
- `src/tools/builtin/market.ts` — `macroRegimeTool`, `marketSignalsTool`
- `src/tools/builtin/market.test.ts` — +8 tool-level tests (mocked DataLayer)
- Registrations: `builtin.ts` source, `scope.ts` scope regex, `guards.ts` READ_ONLY, `auto-persist.ts` Rule 2b for `market_signals`

**Out:**

- F7 alpha combination (composite signals in F3 are simple aggregators; F7 owns the 11-step weighting)
- F8 paper trading commits (transmission chain field stored empty; F8 populates)
- v7.1 chart-pattern vision signals (6th layer in F7 ranking; not here)
- Skill-evolution of signal thresholds (v7.5)

---

## 2. Design decisions resolved upfront

### D-A. Module split

- **Macro** (`src/finance/macro.ts`): pure transform of `MacroPoint[]` series → `MacroRegime`. No I/O. Consumers are the `macroRegimeTool` + future F7.
- **Signals** (`src/finance/signals.ts`): pure detection functions over `MarketBar[]` + F2 indicator arrays. Plus a thin `persistSignals(signals)` that writes to the `market_signals` table. Detection is deterministic and testable; persistence is a separate function with its own test.

### D-B. F5 regime classification is **rules-based**, not LLM-assisted

Per V7 appendix:

- `yieldCurve < 0 && unemploymentRising → recession_risk`
- `fedRateRising && m2Declining → tightening`
- `yieldCurve > 0 && unemploymentFalling && VIX < 20 → expansion`
- `yieldCurveNormalizing && unemploymentPeaking → recovery`

Deterministic rules ship-first. F7 can add LLM-assisted overlays later if the rules produce too-coarse labels. Every rule returns a `{regime, confidence, reasons}` triple so the tool can report _why_ not just _what_.

### D-C. "Rising/falling/normalizing" is quantified, not narrative

Each macro series gets a slope+trend computation:

- `rising`: last 3-period slope > 0 AND latest > avg of prior 6 months
- `falling`: last 3-period slope < 0 AND latest < avg of prior 6 months
- `flat`: neither
- `normalizing`: rising-then-flat OR falling-then-flat (sign change in slope over the last 6 periods)

These are hand-computed against fixture data so audits can verify.

### D-D. Confidence scoring

Each rule fires with:

- `hard`: all conditions met → confidence 0.85
- `soft`: most conditions met (≥ N-1 of N) → confidence 0.55
- `mixed`: signals conflict → "mixed" regime, confidence 0.3

Reduces single-indicator volatility swings from producing whipsaw regime calls.

### D-E. F3 signal detection is **six discrete detectors** plus an aggregator

One function per signal type (pure, same signature shape):

```typescript
detectMaCrossover(closes, fast?, slow?): Signal[]
detectRsiExtremes(closes, overbought?, oversold?): Signal[]
detectMacdCrossover(closes): Signal[]
detectBollingerBreakout(highs, lows, closes): Signal[]
detectVolumeSpike(volumes, sigmaThreshold?): Signal[]
detectPriceThreshold(closes, thresholds): Signal[]
```

Each returns zero-or-more `Signal` objects for the bars in the input. Aggregator `detectAllSignals(bars, thresholds)` calls all six and merges.

### D-F. `Signal` shape

```typescript
interface Signal {
  symbol: string;
  type:
    | "ma_crossover"
    | "rsi_extreme"
    | "macd_crossover"
    | "bollinger_breakout"
    | "volume_spike"
    | "price_threshold";
  direction: "long" | "short" | "neutral";
  strength: number; // 0..1
  price: number;
  timestamp: string;
  description: string; // LLM-facing
  indicators: Record<string, number>; // context snapshot
  transmissionChain: []; // populated by F7/F8; empty at F3
}
```

### D-G. Persistence to `market_signals` table is append-only

F3 writes one row per detected signal. F7 will read via composite queries for alpha weighting. F9 (rituals) will read for daily reports. Schema (F1-pre-allocated) has `indicators_snapshot TEXT` for JSON — F3 writes the indicator context there.

### D-H. `market_signals` tool scans watchlist

Like `market_scan` but instead of scanning a single indicator threshold, runs all 6 detectors on each watchlist symbol's recent history. Returns list of fired signals grouped by symbol. Cache-friendly via DataLayer L2. Also persists firings to DB for F7 consumption.

### D-I. `macro_regime` tool is a snapshot, not a scan

Single tool call returns current regime + the supporting macro values (yield curve, VIX, unemployment, CPI, M2). No scan, no persistence — regime is recomputable on-demand. Future optimization: cache regime for 30-60 min since macro data doesn't change that fast.

### D-J. Scope regex extension (5th and 6th patterns for finance)

Add two new patterns:

- **Macro**: `macro`, `regime`, `régimen`, `yield curve`, `curva de rendimiento`, `fed funds`, `fed rate`, `inflation`, `inflación`, `unemployment`, `desempleo`, `recession`, `recesión`, `VIX`, `M2`
- **Signals**: `signal`, `señal`, `crossover`, `cruce`, `golden cross`, `death cross`, `breakout`, `fuga`, `divergence`, `divergencia`, `trigger`, `detect`, `detectar`

### D-K. Rule 2b auto-persist for `market_signals`

Output is a list of recent signal firings that a follow-up turn may reference ("tell me more about that SPY golden-cross"). Add `market_signals` to the Rule 2b list in `auto-persist.ts`.

### D-L. MA crossover semantics

Fast=50, slow=200 by default (classic "golden/death cross" on daily). Fires **only at crossover event** (current bar's fast-vs-slow diff sign differs from previous bar's), not on every bar where fast > slow. This matches chart-convention "golden cross fires once".

### D-M. Volume spike uses rolling z-score

`volumeSpike` fires when `(volume[i] - mean(last 20)) / std(last 20) > threshold` (default 2σ). Ignores first 20 bars. Matches `feedback_preformat_over_prompt` approach of computable metrics over narrative.

### D-N. Signal direction semantics

- Bullish (expected upside): `long` — golden cross, RSI oversold, MACD bull cross, Bollinger lower-band touch, volume spike + price up
- Bearish (expected downside): `short` — death cross, RSI overbought, MACD bear cross, Bollinger upper-band break, volume spike + price down
- Neutral (informational): `neutral` — raw price thresholds without directional context

### D-O. Tool ACI parallel to `market_scan`

Both new tools use JSONSchema (not Zod directly — consistent with other builtin tools). Enum constraints where possible. Every param has a `description`.

---

## 3. File manifest

| Path                                   | Action | LOC  | Purpose                                                      |
| -------------------------------------- | ------ | ---- | ------------------------------------------------------------ |
| `src/finance/macro.ts`                 | CREATE | ~200 | Regime classifier + helpers                                  |
| `src/finance/macro.test.ts`            | CREATE | ~200 | ~14 tests                                                    |
| `src/finance/signals.ts`               | CREATE | ~260 | 6 detectors + aggregator + persist                           |
| `src/finance/signals.test.ts`          | CREATE | ~260 | ~22 tests                                                    |
| `src/tools/builtin/market.ts`          | MODIFY | +200 | macroRegimeTool + marketSignalsTool                          |
| `src/tools/builtin/market.test.ts`     | MODIFY | +150 | +8 tool tests                                                |
| `src/tools/sources/builtin.ts`         | MODIFY | +4   | Register 2 new tools                                         |
| `src/messaging/scope.ts`               | MODIFY | +10  | 2 new activation patterns, 2 new tool names in FINANCE_TOOLS |
| `src/inference/guards.ts`              | MODIFY | +2   | Both tools → READ_ONLY                                       |
| `src/memory/auto-persist.ts`           | MODIFY | +1   | `market_signals` to Rule 2b                                  |
| `src/runners/write-tools-sync.test.ts` | MODIFY | +2   | Expand FINANCE_READ_ONLY                                     |

**Totals**: 5 modified, 4 created. ~1300 LOC gross. Zero new deps.

---

## 4. Macro regime classifier (exact types + rules)

```typescript
// src/finance/macro.ts

export type Regime =
  | "expansion"
  | "tightening"
  | "recession_risk"
  | "recovery"
  | "mixed";

export interface MacroRegime {
  regime: Regime;
  confidence: number; // 0..1
  yieldCurve: number; // 10Y - 2Y
  fedRate: number;
  vix: number;
  unemployment: number;
  inflationYoY: number;
  m2GrowthYoY: number;
  initialClaims: number;
  reasons: string[]; // LLM-facing why-list
}

export function classifyRegime(series: MacroSeriesBundle): MacroRegime;

interface MacroSeriesBundle {
  fedFunds: MacroPoint[];
  treasury2y: MacroPoint[];
  treasury10y: MacroPoint[];
  cpi: MacroPoint[];
  unemployment: MacroPoint[];
  m2: MacroPoint[];
  vixcls: MacroPoint[];
  icsa: MacroPoint[];
}
```

Rules:

1. `recession_risk` if `yieldCurve < 0 && unemploymentTrend === "rising"`
2. `tightening` if `fedRateTrend === "rising" && m2Trend === "falling"`
3. `expansion` if `yieldCurve > 0.5 && unemploymentTrend === "falling" && vix < 20`
4. `recovery` if `yieldCurveTrend === "normalizing" && unemploymentTrend === "peaking"`

Conflict resolution: if 2+ rules fire, return `mixed` unless one has strictly more matching conditions.

## 5. Signal detectors (exact signatures)

```typescript
// src/finance/signals.ts

export interface Signal {
  symbol: string;
  type: SignalType;
  direction: "long" | "short" | "neutral";
  strength: number;
  price: number;
  timestamp: string;
  description: string;
  indicators: Record<string, number>;
  transmissionChain: [];
}

export type SignalType =
  | "ma_crossover"
  | "rsi_extreme"
  | "macd_crossover"
  | "bollinger_breakout"
  | "volume_spike"
  | "price_threshold";

export function detectMaCrossover(
  bars: MarketBar[],
  fast?: number,
  slow?: number,
): Signal[];
export function detectRsiExtremes(
  bars: MarketBar[],
  overbought?: number,
  oversold?: number,
  period?: number,
): Signal[];
export function detectMacdCrossover(bars: MarketBar[]): Signal[];
export function detectBollingerBreakout(
  bars: MarketBar[],
  period?: number,
  stdDev?: number,
): Signal[];
export function detectVolumeSpike(
  bars: MarketBar[],
  sigma?: number,
  window?: number,
): Signal[];
export function detectPriceThreshold(
  bars: MarketBar[],
  thresholds: number[],
): Signal[];

export function detectAllSignals(
  bars: MarketBar[],
  opts?: DetectOpts,
): Signal[];
export function persistSignals(signals: Signal[]): number; // rows inserted
```

## 6. Tool surfaces

### `macro_regime`

```typescript
// No parameters. Returns snapshot summary:
//   Regime: expansion (confidence 0.85)
//   Yield curve: +1.24  (10Y 4.20 / 2Y 2.96)
//   Fed funds: 4.25 (trend: falling)
//   VIX: 17.3 (trend: stable)
//   Unemployment: 3.8 (trend: falling)
//   CPI YoY: 2.4
//   M2 YoY: 3.1
//   Reasons: yield curve positive; unemployment falling; VIX < 20
```

### `market_signals`

```typescript
{
  symbol?: string,              // if omitted: scan watchlist
  interval?: "daily" | "60min", // default daily
  lookback?: number,            // default 100
  tags?: string[],              // filter watchlist by tags
  types?: SignalType[]          // filter which detectors run
}
// Returns grouped firings:
//   SPY (daily, 100 bars) — 3 signals:
//     2026-04-15 | ma_crossover | long  | SMA(50) crossed above SMA(200) (golden cross) @ 519.30
//     2026-04-10 | bollinger_breakout | short | price closed above upper band (529.1 vs 527.8) @ 530.12
//     2026-04-03 | rsi_extreme | long  | RSI(14)=28.2 (oversold) @ 510.45
```

---

## 7. Integration-checklist walkthrough

| Row | Action           | Where                                                                      |
| --- | ---------------- | -------------------------------------------------------------------------- |
| 1   | Handlers         | `market.ts` — append 2 tools                                               |
| 2   | Source register  | `builtin.ts` — both in BUILTIN_TOOLS                                       |
| 3   | Scope group      | `scope.ts` — 2 new activation patterns + 2 new tool names in FINANCE_TOOLS |
| 4   | READ_ONLY        | `guards.ts` — both tools                                                   |
| 5   | Rule 2b          | `auto-persist.ts` — add `market_signals` (output feeds follow-up turns)    |
| 6   | write-tools-sync | `write-tools-sync.test.ts` — expand FINANCE_READ_ONLY                      |
| 7   | Tests            | `macro.test.ts`, `signals.test.ts`, `market.test.ts` extension             |

---

## 8. Implementation order (~5h)

| #   | Step                                                                 | Time |
| --- | -------------------------------------------------------------------- | ---- |
| 1   | `macro.ts` types + slope/trend helpers                               | 30m  |
| 2   | `macro.ts` classifier rules + conflict resolution                    | 30m  |
| 3   | `macro.test.ts` — 14 tests                                           | 45m  |
| 4   | `signals.ts` — 6 detectors                                           | 60m  |
| 5   | `signals.ts` — aggregator + persistence                              | 20m  |
| 6   | `signals.test.ts` — 22 tests                                         | 60m  |
| 7   | `market.ts` — 2 new tools                                            | 45m  |
| 8   | `market.test.ts` — 8 tool tests                                      | 30m  |
| 9   | Integration wiring (builtin, scope, guards, auto-persist, sync test) | 15m  |
| 10  | Full typecheck + test suite                                          | 5m   |
| 11  | qa-auditor                                                           | 10m  |
| 12  | Fix audit findings                                                   | 30m  |
| 13  | Deploy + smoke                                                       | 15m  |
| 14  | Docs + memory + commit + PR + merge                                  | 25m  |

**Total ~6h. Budget: 1.5 session (F5=0.5 + F3=1.0 bundled).**

---

## 9. Smoke test plan

1. `npm run typecheck` — zero errors
2. `npm test` — 2361 → ~2397 (+36 target)
3. Live: `macro_regime` tool — fetches FEDFUNDS + CPI + UNEMPLOYMENT + VIXCLS + ICSA + M2 + TREASURY_YIELD × 2 (8 macro pulls), runs classifier, returns snapshot
4. Live: `market_signals symbol: "SPY"` — fetch 100 daily bars, run all 6 detectors, persist firings, return list
5. `./mc-ctl db "SELECT COUNT(*) FROM market_signals"` — confirm persistence

---

## 10. Risks + mitigations

| Risk                                                                    | Mitigation                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Macro-series alignment (different cadences: monthly vs weekly vs daily) | Classifier takes most-recent-available per series; document staleness in reasons[]                                                    |
| Yield curve sign inversion near zero (±0.05)                            | Threshold for "inverted" is `< 0`, not `<= 0`; normalized-trend check for `-0.5 < x < 0.5`                                            |
| Signal detector double-counting at re-entry                             | MA crossover only fires at **sign change** (audit E1 precedent); RSI fires only at **first bar** crossing the extreme, not while held |
| Scan fan-out rate budget                                                | DataLayer L2 serves warm scans; even cold = 29 AV daily calls, under 60/min ceiling                                                   |
| Scope regex missing real user phrasing                                  | 2 new patterns + scope.test.ts positive cases for 6+ sample phrases                                                                   |
| Signal persistence race                                                 | better-sqlite3 is synchronous; INSERT OR IGNORE avoids duplicate key errors on re-detection                                           |

---

## 11. Acceptance criteria

- [ ] ~36 new tests, all green
- [ ] 0 type errors
- [ ] qa-auditor PASS or PASS WITH WARNINGS
- [ ] Live `macro_regime` returns sane regime label + reasons (likely `expansion` or `tightening` given current macro)
- [ ] Live `market_signals symbol=SPY` returns ≥1 firing (SPY RSI at 73.18 in S2 smoke → should trigger rsi_extreme overbought)
- [ ] `market_signals` table has rows after first scan
- [ ] V7-ROADMAP F5 and F3 both marked Done, Phase β status 4/12

---

## 12. Handoff to F6/F6.5 (S4)

After this PR merges, S4 is unblocked: F6 (Polymarket/Kalshi + whales) + F6.5 (sentiment signals). Both are independent external-data fetchers; neither depends on F3/F5 output. F6 is parallelizable with F6.5, both in one session per ordering-map.

F7 (alpha combination, S6) will be the next _synthetic_ session — it reads everything F3/F5/F6/F6.5 produces.
