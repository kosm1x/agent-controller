# V7 — Financial Signal Detection Stack

> Pre-planning document. Foundation for Jarvis v7: detect, analyze, and alert on financial market signals.

## Vision

Jarvis monitors financial instruments (stocks, crypto, forex, commodities), computes technical indicators, detects actionable signals, and delivers alerts with analysis via WhatsApp/Telegram. Text-first, charts later.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Layer 4: Delivery                     │
│  WhatsApp / Telegram / Email / Scheduled Reports         │
│  (existing: messaging router, rituals, proactive scanner)│
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                 Layer 3: Visualization (v7.1)            │
│  TradingView lightweight-charts + Puppeteer → PNG        │
│  Candlestick + indicator overlays + signal markers       │
│  (DEFERRED — text signals first, charts when proven)     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│              Layer 2b: Paper Trading (F8)                │
│  pm-trader MCP server (29 tools, stdio)                  │
│  Jarvis practices: thesis → trade → track → prove        │
│  Track record builds credibility before alerting user    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│              Layer 2a: Signal Detection                  │
│                                                          │
│  Indicator Engine (pure math, no deps):                  │
│  ├── SMA, EMA (simple/exponential moving average)        │
│  ├── RSI (relative strength index, 14-period default)    │
│  ├── MACD (12/26/9 EMA crossover + histogram)            │
│  ├── Bollinger Bands (20-period, 2σ)                     │
│  ├── VWAP (volume-weighted average price)                 │
│  ├── ATR (average true range — volatility)               │
│  └── Volume anomaly (z-score from rolling baseline)      │
│                                                          │
│  Signal Detector:                                        │
│  ├── MA crossover (golden cross / death cross)           │
│  ├── RSI extremes (oversold < 30, overbought > 70)       │
│  ├── MACD signal line crossover                          │
│  ├── Bollinger Band breakout (price outside bands)       │
│  ├── Volume spike (> 2σ above 20-day average)            │
│  ├── Price threshold alerts (user-defined)               │
│  └── Custom composite signals (combine any indicators)   │
│                                                          │
│  Sentiment Signals (from Vibe-Trading gap analysis):     │
│  ├── Fear & Greed Index (0-100, alternative.me API)      │
│  ├── Crypto funding rates (long/short leverage)          │
│  ├── Liquidation heatmaps (forced selling cascades)      │
│  └── Stablecoin flows (money entering/leaving crypto)    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│               Layer 1: Data Sources                      │
│                                                          │
│  Free / no-key APIs:                                     │
│  ├── Yahoo Finance (yfinance-style scraping)             │
│  ├── CoinGecko (crypto — already in Intel Depot)         │
│  ├── Frankfurter (forex — already in Intel Depot)        │
│  ├── Open-Meteo (commodities correlation — existing)     │
│  ├── Google Finance (basic quotes, no API key)           │
│  ├── Polymarket Gamma API (prediction market events)     │
│  ├── Kalshi REST API (binary outcome markets, 20 RPS)   │
│  └── Polymarket Data API (whale trade history, 7d)       │
│                                                          │
│  Smart money (whale tracking):                           │
│  ├── Auto-discover top traders by win rate + ROI          │
│  ├── Score across 6 dimensions (profit, timing, slip...)  │
│  ├── Track moves in real-time → signal layer 4            │
│  └── Jarvis learns: follow vs fade whale = training data │
│                                                          │
│  Macro data (dual source):                               │
│  ├── Alpha Vantage: fed funds, treasury yields,          │
│  │   CPI, unemployment, nonfarm payroll, GDP             │
│  ├── FRED REST API (3 series AV doesn't cover):          │
│  │   ├── VIXCLS (VIX — volatility/fear gauge)            │
│  │   ├── ICSA (initial claims — weekly leading)          │
│  │   └── M2SL (money supply — liquidity indicator)       │
│  └── TypeScript fetch — no Python sidecar                │
│                                                          │
│  Supplemental APIs:                                      │
│  ├── Binance WebSocket (real-time crypto, free)          │
│  ├── Alpha Vantage NEWS_SENTIMENT (per-ticker sentiment) │
│  └── Alpha Vantage server-side indicators (golden-file)  │
│                                                          │
│  Storage:                                                │
│  ├── SQLite table: market_data (ticker, date, OHLCV)     │
│  ├── Rolling retention: 1 year daily, 30 days intraday   │
│  └── Dedup: INSERT OR IGNORE on (ticker, timeframe, ts)  │
└─────────────────────────────────────────────────────────┘
```

## Data Model

### market_data table

```sql
CREATE TABLE IF NOT EXISTS market_data (
  id         INTEGER PRIMARY KEY,
  ticker     TEXT NOT NULL,           -- 'AAPL', 'BTC-USD', 'EUR/MXN'
  timeframe  TEXT NOT NULL,           -- '1d', '1h', '5m'
  ts         TEXT NOT NULL,           -- ISO datetime (UTC)
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     REAL DEFAULT 0,
  source     TEXT DEFAULT 'unknown',  -- 'alphavantage', 'yahoo', 'coingecko'
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticker, timeframe, ts)
);
CREATE INDEX IF NOT EXISTS idx_market_ticker_ts ON market_data(ticker, timeframe, ts);
```

### watchlist table

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY,
  ticker     TEXT NOT NULL UNIQUE,
  name       TEXT,                    -- 'Apple Inc', 'Bitcoin'
  asset_type TEXT DEFAULT 'stock',    -- 'stock', 'crypto', 'forex', 'commodity'
  alerts     TEXT DEFAULT '[]',       -- JSON: [{type:'rsi_oversold', threshold:30}]
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### backtest_results table

```sql
CREATE TABLE IF NOT EXISTS backtest_results (
  id            INTEGER PRIMARY KEY,
  strategy      TEXT NOT NULL,          -- 'rsi_reversion', 'ema_crossover', etc.
  regime        TEXT NOT NULL,          -- 'trending', 'ranging', 'volatile'
  ticker        TEXT NOT NULL,
  period_start  TEXT NOT NULL,          -- ISO date
  period_end    TEXT NOT NULL,
  win_rate      REAL NOT NULL,
  sharpe        REAL,
  max_drawdown  REAL,
  trade_count   INTEGER NOT NULL,
  stress_passed INTEGER DEFAULT 0,     -- how many of 5 stress scenarios survived
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_results(strategy, regime, ticker);
```

### trade_theses table

```sql
CREATE TABLE IF NOT EXISTS trade_theses (
  id              INTEGER PRIMARY KEY,
  ticker          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open', 'tracking', 'resolved', 'broken'
  thesis          TEXT NOT NULL,                 -- "BTC RSI oversold, macro stable, expect bounce"
  direction       TEXT NOT NULL,                 -- 'bullish', 'bearish'
  evidence        TEXT DEFAULT '[]',             -- JSON: [{signal, weight, timestamp}]
  transmission    TEXT DEFAULT '[]',             -- JSON: [{from, to, mechanism, confidence}]
  evolution       TEXT DEFAULT 'new',            -- 'new', 'strengthened', 'weakened', 'falsified'
  mega_alpha      REAL,                          -- combined signal at thesis creation
  entry_price     REAL,                          -- price when paper trade entered
  exit_price      REAL,                          -- price when resolved/broken
  outcome         TEXT,                          -- what actually happened
  lessons         TEXT,                          -- extracted post-resolution
  created_at      TEXT DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_theses_status ON trade_theses(status, ticker);
```

### api_call_budget table

```sql
CREATE TABLE IF NOT EXISTS api_call_budget (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,            -- 'alphavantage', 'fred', 'polymarket', 'yahoo'
  date       TEXT NOT NULL,            -- ISO date (UTC)
  calls      INTEGER NOT NULL DEFAULT 0,
  limit_day  INTEGER NOT NULL,         -- max calls/day for this source
  UNIQUE(source, date)
);
CREATE INDEX IF NOT EXISTS idx_api_budget_source ON api_call_budget(source, date);
```

## Tools (6 new, all deferred)

| Tool                | Purpose                                                                      | Scope Group |
| ------------------- | ---------------------------------------------------------------------------- | ----------- |
| `market_quote`      | Current price + daily change for a ticker                                    | `finance`   |
| `market_history`    | OHLCV history for a ticker + timeframe                                       | `finance`   |
| `market_indicators` | Compute SMA/EMA/RSI/MACD/Bollinger for a ticker                              | `finance`   |
| `market_signals`    | Detect active signals across watchlist                                       | `finance`   |
| `watchlist_manage`  | Add/remove/list watchlist tickers + alert configs                            | `finance`   |
| `market_scan`       | Scan multiple tickers for a specific condition                               | `finance`   |
| `macro_dashboard`   | Macro regime: yield curve, VIX, fed funds, employment, inflation (AV + FRED) | `finance`   |
| `prediction_market` | Polymarket/Kalshi top markets, probabilities, 24h shifts                     | `finance`   |

### Scope pattern

```typescript
// finance scope group
{
  pattern: /\b(mercado|market|acci[oó]n|stock|precio|price|ticker|bolsa|crypto|bitcoin|btc|eth|forex|divisas?|tipo\s+de\s+cambio|rsi|macd|bollinger|sma|ema|vwap|volumen|volume|overbought|oversold|sobrecompra|sobreventa|cruce\s+de\s+medias|golden\s+cross|death\s+cross|señal\s+(de\s+)?compra|señal\s+(de\s+)?venta|buy\s+signal|sell\s+signal|polymarket|kalshi|predicci[oó]n|prediction\s+market|probabilidad|apuesta|odds)\b/i,
  group: "finance",
}
```

## Indicator Engine API

```typescript
// src/finance/indicators.ts — pure functions, zero deps

// Moving averages
function sma(closes: number[], period: number): (number | null)[];
function ema(closes: number[], period: number): (number | null)[];

// Momentum
function rsi(closes: number[], period?: number): (number | null)[];
function macd(
  closes: number[],
  fast?: number,
  slow?: number,
  signal?: number,
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
};

// Volatility
function bollingerBands(
  closes: number[],
  period?: number,
  stdDev?: number,
): {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
};
function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period?: number,
): (number | null)[];

// Volume
function vwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): (number | null)[];
function volumeZScore(volumes: number[], period?: number): (number | null)[];
```

## Signal Detector API

```typescript
// src/finance/signals.ts

interface Signal {
  ticker: string;
  type: string; // 'ma_crossover', 'rsi_oversold', 'volume_spike', etc.
  direction: "bullish" | "bearish" | "neutral";
  strength: number; // 0-1 confidence
  price: number;
  timestamp: string;
  description: string; // Human-readable: "BTC RSI at 28 (oversold)"
  indicators: Record<string, number>; // Supporting data
}

function detectSignals(
  ticker: string,
  data: OHLCV[],
  config?: SignalConfig,
): Signal[];

// Regime-aware signal weighting (from Polymarket Trading Bot pattern)
type MarketRegime = "trending" | "ranging" | "volatile";
function detectRegime(data: OHLCV[], period?: number): MarketRegime;

// Alpha Combination Engine (from RohOnChain / Fundamental Law of Active Management)
//
// NOT a voting system ("3 of 5 agree"). Instead: mathematically optimal weighting
// based on each signal's INDEPENDENT contribution after removing shared variance.
//
// IR = IC × √N  (Information Ratio = avg Information Coefficient × √independent signals)
// 50 weak signals at IC=0.05 → IR=0.354 (beats single signal at IC=0.10)
//
// The 11-step procedure:
// 1. Collect return series per signal
// 2. Serial demean (remove drift)
// 3. Calculate variance per signal
// 4. Normalize to common scale
// 5. Drop most recent observation (prevent look-ahead)
// 6. Cross-sectional demean (remove shared market-wide effects)
// 7. Drop final period (data hygiene)
// 8. Calculate forward expected return per signal
// 9. Regress to isolate INDEPENDENT contribution (critical step)
// 10. Weight = independent_edge / volatility (penalize noise)
// 11. Normalize weights to sum to 1

interface AlphaWeight {
  signalName: string;
  weight: number; // optimal weight from combination engine
  informationCoefficient: number; // IC: correlation of signal vs outcome
  independentContribution: number; // what this adds that no other signal covers
}

function combineAlpha(
  signals: Signal[],
  historicalReturns: SignalReturnSeries[],
  regime: MarketRegime,
): {
  megaAlpha: number; // combined probability/direction estimate
  weights: AlphaWeight[]; // per-signal optimal weights
  effectiveN: number; // actual independent signals (≤ total signals)
  informationRatio: number; // IR of the combined system
  edge: number; // gap between megaAlpha and market price
  actionable: boolean; // edge > minimum threshold
};

// Position sizing: empirical Kelly adjusted for estimation uncertainty
// f = f_kelly × (1 - CV_edge)  where CV_edge from Monte Carlo simulation
function kellySize(
  edge: number,
  odds: number,
  cvEdge: number, // coefficient of variation from simulation
): number;
```

### Shadow Portfolio (validation before alerting)

Before sending live alerts, simulate the last 30 days of signals and report hypothetical P&L. Builds credibility and catches broken signal logic before it reaches the user.

```typescript
// src/finance/shadow.ts
function backtest(
  signals: Signal[],
  priceHistory: OHLCV[],
): {
  totalReturn: number;
  winRate: number;
  sharpe: number;
  maxDrawdown: number;
  tradeCount: number;
};
```

### Replication Scoring (am I trading like the winners?)

After each paper trade batch, compare Jarvis's decisions against top whale decisions for the same markets. Measures whether Jarvis is converging toward smart money behavior.

```typescript
// src/finance/replication.ts (from Polybot pattern)
function replicationScore(
  jarvisTrades: PaperTrade[],
  whaleTrades: WhaleTrade[],
): {
  alignment: number; // 0-1 how closely Jarvis mirrors whale consensus
  directionMatch: number; // % of trades where Jarvis and whales agree on direction
  timingDelta: number; // avg seconds between Jarvis entry and whale entry
  trend: "converging" | "diverging" | "stable";
};
```

If alignment is high → Jarvis signals are tracking smart money (good).
If alignment is low but win rate is high → Jarvis found its own edge (also good).
If alignment is low AND win rate is low → retune signal weights.

## Macro Regime Detection (Alpha Vantage + FRED)

```typescript
// src/finance/macro.ts — TypeScript fetch, no Python sidecar

interface MacroRegime {
  regime: "expansion" | "tightening" | "recession_risk" | "recovery";
  yieldCurve: number; // 10Y-2Y spread (< 0 = inverted)
  fedRate: number; // fed funds rate current level
  vix: number; // VIX current level
  unemployment: number; // latest monthly
  inflationYoY: number; // CPI year-over-year %
  m2GrowthYoY: number; // M2 money supply year-over-year %
  initialClaims: number; // ICSA latest weekly
  signals: MacroSignal[];
}

interface MacroSignal {
  type: string; // 'yield_curve_inversion', 'vix_spike', 'employment_miss'
  severity: "watch" | "warning" | "alert";
  description: string;
}

// Regime rules:
// - yieldCurve < 0 + unemployment rising → recession_risk
// - fedRate rising + M2 declining → tightening
// - yieldCurve > 0 + unemployment falling + VIX < 20 → expansion
// - yieldCurve normalizing + unemployment peaking → recovery
```

**Data sources (dual):**

| Indicator           | Source        | Endpoint                         | Frequency |
| ------------------- | ------------- | -------------------------------- | --------- |
| Fed Funds Rate      | Alpha Vantage | `FEDERAL_FUNDS_RATE`             | Daily     |
| Treasury 2Y         | Alpha Vantage | `TREASURY_YIELD maturity=2year`  | Daily     |
| Treasury 10Y        | Alpha Vantage | `TREASURY_YIELD maturity=10year` | Daily     |
| Yield Curve         | Computed      | 10Y - 2Y from above              | Daily     |
| CPI                 | Alpha Vantage | `CPI`                            | Monthly   |
| Unemployment        | Alpha Vantage | `UNEMPLOYMENT`                   | Monthly   |
| Nonfarm Payroll     | Alpha Vantage | `NONFARM_PAYROLL`                | Monthly   |
| GDP                 | Alpha Vantage | `REAL_GDP`                       | Quarterly |
| **VIX**             | **FRED**      | `VIXCLS`                         | Daily     |
| **Initial Claims**  | **FRED**      | `ICSA`                           | Weekly    |
| **M2 Money Supply** | **FRED**      | `M2SL`                           | Monthly   |

**Integration:** All TypeScript `fetch()` — Alpha Vantage uses existing adapter, FRED uses `https://api.stlouisfed.org/fred/series/observations?series_id=X&api_key=Y&file_type=json`. Cached in SQLite (daily refresh for daily series, monthly for monthly). Macro regime injected into signal context so technical signals get regime-aware interpretation.

## Rituals

| Ritual              | Schedule                        | Delivery                       |
| ------------------- | ------------------------------- | ------------------------------ |
| Morning market scan | 7:30 AM MX (before market open) | Telegram + Email               |
| Mid-day check       | 1:00 PM MX                      | Telegram (if signals detected) |
| End-of-day summary  | 4:30 PM MX (after market close) | Telegram + Email               |
| Crypto 24/7 monitor | Every 4 hours                   | Telegram (if signals)          |

## Delivery Format (text-first)

```
📊 **Señales de Mercado — 10 Abr 2026, 7:30 AM**

🟢 **BTC-USD** $62,450 (-3.2%)
  RSI: 28 (sobreventa) | Bollinger: precio bajo banda inferior
  Señal: COMPRA — RSI extremo + soporte Bollinger

🔴 **AAPL** $187.30 (+1.8%)
  MACD: cruce bajista | SMA20 > SMA50 por $2.10
  Señal: PRECAUCIÓN — MACD diverge del trend

⚪ **EUR/MXN** $18.45 (-0.1%)
  Sin señales activas. Rango lateral.

_Watchlist: 12 tickers | 2 señales activas | Próximo scan: 1:00 PM_
```

## Paper Trading — Jarvis Learns to Trade (F8)

**Progression:** Detect → Hypothesize → Practice → Prove → Alert

Instead of just reporting signals, Jarvis paper trades them on Polymarket via the `pm-trader` MCP server (agent-next/polymarket-paper-trader). This builds a track record that proves signal quality before recommending actions to the user.

```
12 signals fire across 5 layers:
  RSI=28, Bollinger low, volume spike (technical)
  Yield curve stable, VIX=18 (macro)
  Polymarket BTC-UP at 0.62 (crowd)
  Top 3 whales bought in last hour (smart money)
  Fear index=22, funding rates negative (sentiment)

Alpha Combination Engine (11-step procedure):
  → Strips shared variance: RSI + Bollinger are correlated (same price data)
  → Effective independent signals: 7 of 12 (5 were redundant)
  → Weights: whale flow 0.23, funding rates 0.19, VIX 0.17, RSI 0.14, ...
  → Combined megaAlpha: 0.71 probability of bounce
  → Market price: 0.62 → Edge: +0.09
  → Kelly size (uncertainty-adjusted): $85 paper trade

  → Backtests strategy on last 30 days with walk-forward (F7.5)
  → Stress test: survives 4/5 historical crash scenarios
  → Paper trades on Polymarket (F8)
  → Scores vs whale consensus: 72% alignment (replication)
  → After 30+ trades: "62% win rate, 1.3 Sharpe, IR=0.35"
  → NOW alerts user with evidence
```

**Integration:** MCP server (`pm-trader mcp` via stdio). 29 tools: search_markets, buy, sell, portfolio, stats, backtest, etc. Same protocol as Lightpanda/Playwright — add to `mcp-servers.json`, tools auto-discovered.

**Delivery format with track record:**

```
📊 **Señal de Mercado — BTC-USD**

🟢 **MegaAlpha: 0.71** (mercado: 0.62) → Edge: +9%
  7 señales independientes de 12 totales (5 redundantes filtradas)
  Top pesos: whale flow 23%, funding 19%, VIX 17%, RSI 14%

📈 **Mi historial:**
  Trades: 47 | Win rate: 62% | Sharpe: 1.3 | IR: 0.35
  Smart money: 72% alineado | Estrés: sobrevive 4/5 crashes

_¿Procedo con paper trade? Responde "sí" para ejecutar_
```

## Strategy Backtester — Learn Before You Trade (F7.5)

Before paper trading, Jarvis backtests its thesis against historical data. Nine strategy templates from the prediction-market-backtesting playbook:

| Strategy                 | Logic                                    | Best Regime |
| ------------------------ | ---------------------------------------- | ----------- |
| Mean Reversion           | Buy when price < rolling_avg - threshold | Ranging     |
| EMA Crossover            | Buy when fast_ema >= slow_ema            | Trending    |
| Breakout                 | Buy when price > mean + n\*std           | Volatile    |
| RSI Reversion            | Buy when RSI < entry_threshold           | Ranging     |
| Panic Fade               | Buy panic selloffs below threshold       | Volatile    |
| VWAP Reversion           | Buy dislocation from trade-tick VWAP     | Ranging     |
| Final Period Momentum    | Buy late-game strength near expiry       | Any         |
| Late Favorite Limit Hold | Limit buy high-probability favorites     | Trending    |
| Threshold Momentum       | Buy absolute price threshold crossovers  | Trending    |

**Validation flow:**

```
Signal: "BTC RSI at 28, macro stable, fear index at 22"
  → Regime: RANGING
  → Backtest RSI Reversion + Mean Reversion + VWAP (ranging strategies)
  → Walk-forward validation (not naive backtest — train/test split rolls forward)
  → Stress test: "Would this strategy survive 2020 COVID crash?"
  → Results: RSI Reversion 65% win rate, survived 4/5 stress scenarios
  → Select: RSI Reversion (best for current regime + stress-resilient)
  → Paper trade with RSI Reversion entry/exit rules
  → Track: did the backtest-selected strategy outperform random?
```

**Walk-forward validation** (from Vibe-Trading): Train on months 1-6, test on month 7. Roll forward. This prevents overfitting — a strategy that only works "in backtest" gets filtered out.

**Stress testing** (from Vibe-Trading): Pre-built scenarios (2008, 2020, rate shock, credit crisis, liquidity dry-up). "This strategy has 65% win rate AND survives historical crashes" is fundamentally different from "65% win rate in calm markets."

Over time, Jarvis learns which strategy works for which regime — adapting its playbook based on evidence, not intuition.

## Implementation Order

| Phase    | What                                                                                                                                                                                                | Sessions | Deps          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| **F1**   | Schema (6 tables), Alpha Vantage adapter (premium: adjusted daily, FX, macro, news sentiment) + Yahoo fallback, data validation, timezone normalization, api_call_budget tracking, gold via GLD ETF | 1.5      | None          |
| **F2**   | Indicator engine (SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR, ROC, Williams %R) + golden-file tests (validated against AV server-side indicators)                                                    | 1        | F1            |
| **F4**   | Watchlist management + market_quote/history tools                                                                                                                                                   | 1        | F1            |
| **F3**   | Signal detector + market_signals tool + transmission chain field                                                                                                                                    | 1        | F2 + F4       |
| **F5**   | Macro regime detection — Alpha Vantage (fed funds, treasury, CPI, unemployment, payroll, GDP) + FRED REST API (VIX, ICSA, M2). TypeScript fetch, no Python sidecar                                  | 0.5      | F1            |
| **F6**   | Prediction markets (Polymarket/Kalshi) + whale tracker (Polymarket trade history + SEC EDGAR insider filings)                                                                                       | 1.5      | None          |
| **F6.5** | Sentiment signals (fear/greed, funding rates, liquidations)                                                                                                                                         | 0.5      | None          |
| **F7**   | Alpha Combination Engine (11-step) + signal evolution + ISQ dimensions + per-layer freshness + weight versioning + min signal threshold                                                             | 2        | F3+F5+F6+F6.5 |
| **F7.5** | Strategy backtester (walk-forward + stress test) → backtest_results table                                                                                                                           | 1        | F7            |
| **F8**   | Paper trading via pm-trader MCP + trade_theses commitment tracking + transaction costs                                                                                                              | 1.5      | F7.5          |
| **F9**   | Morning/EOD market scan rituals + market calendar + dynamic alert budget                                                                                                                            | 1        | F8 + F4       |
| **F10**  | Real-time crypto via Binance WebSocket (optional)                                                                                                                                                   | 1        | F3            |
| **v7.1** | Chart rendering (lightweight-charts + Puppeteer → PNG) + vision chart patterns (6th signal layer)                                                                                                   | 1.5      | F3            |
| **v7.2** | Knowledge graph layer (Graphify MCP — CRM + codebase + corpus)                                                                                                                                      | 1.5      | None          |
| **v7.3** | Digital marketing planner & buyer (claude-ads patterns + Meta/Google Ads API)                                                                                                                       | 3        | None          |
| **v7.4** | Video production enhancement (AI asset generation + storyboard pipeline + lip sync)                                                                                                                 | 2        | v7.3          |

### Dependency Graph

```
F1 (data layer — AV premium + Yahoo fallback)
├── F2 (indicators) ──┐
├── F4 (watchlist) ────┤
├── F5 (macro — AV + FRED fetch) ─┤
│                      F3 (signal detector)
│                                  │
F6 (prediction markets) ──────────┤
F6.5 (sentiment) ─────────────────┤
                                   │
                            F7 (combination engine)
                                   │
                            F7.5 (backtester)
                                   │
                            F8 (paper trading)
                                   │
                      F9 (scan rituals — last, needs track record)

Parallel branches (after F3):
  F10 (crypto websocket)
  v7.1 (charts + vision)

Independent (no v7 deps):
  v7.2 (knowledge graph)
  v7.3 (digital marketing) ── v7.4 (video production)

Deferred to v7.x (post-launch):
  TimesFM forecasting (Python sidecar, 6th signal layer)
```

### Parallelization Opportunities

F5 is now 0.5 sessions (TypeScript fetch, no sidecar) and slots into F1 or runs alongside F2/F4. F6 and F6.5 have no dependencies on each other. The critical path is: **F1 → F2 → F4 → F3 → F7 → F7.5 → F8 → F9**. Everything else can slot around it.

## Production Hardening (built into phases, zero extra sessions)

### H1. Golden-File Indicator Tests (F2)

Every indicator gets a `*.golden.json` fixture — known input (100 days of real OHLCV), expected output verified against a reference source (TradingView or TA-Lib values). Tests compare to 6 decimal places. If the RSI math is wrong, tests catch it before signals are generated. This is the difference between "looks right" and "is right."

### H2. Data Validation Layer (F1)

`validateOHLCV()` runs on every ingested record before storage:

- Reject: price ≤ 0, high < low, volume negative, NaN/null
- Flag: >10% gap from previous close without corresponding volume spike (possible API glitch)
- Log: data quality score per source per day to `api_call_budget` table

Bad data never reaches the indicator engine.

### H3. Timezone & Market Convention (F1)

All timestamps stored in **UTC**. Each data adapter normalizes on ingestion via `normalizeTimestamp(raw, source) → UTC ISO`.

Jarvis uses **market-native timezones** for financial references and alerts — not Mexico City time:

- US stocks: ET (NYSE/NASDAQ). "Market opens at 9:30 AM ET"
- FOREX: 24/5, daily candle closes at 5 PM ET (NY close convention)
- Crypto: 24/7, candles close at midnight UTC
- Asia (Tokyo/Shanghai/HK): JST/CST/HKT. "Asia session opens Sunday 4 PM MX time"
- FRED macro: release dates in ET
- User sync: Mexico City time for rituals, morning briefings, personal scheduling

The user's local time is for Jarvis-to-human communication. Market references use each market's native convention.

### H4. Market Calendar (F9)

`isMarketOpen(assetType, datetime) → boolean`

- US stocks: NYSE holiday calendar (static, updated annually). Skip stock scans on holidays. Don't alert "no signals" when market was closed
- FOREX: 24/5 (Sunday 5 PM ET → Friday 5 PM ET). Closed weekends
- Crypto: always open
- Asia: TSE/SSE/HKEX calendars for sector-specific scans

Morning scan ritual checks calendar before firing. No wasted API calls on closed markets.

### H5. Paper Trading Transaction Costs (F8)

`transactionCost(assetType, ticker) → { spread, fee }`

| Asset              | Cost Model                                                 |
| ------------------ | ---------------------------------------------------------- |
| FOREX              | 1-3 pip spread (pair + session dependent)                  |
| US stocks          | $0.005/share (commission-free assumption) + $0.01 slippage |
| Crypto             | 0.1% taker fee                                             |
| Prediction markets | Built into odds spread                                     |

Paper P&L calculated **after** costs. A strategy that wins 55% with zero spread might win 48% with realistic costs — know this during paper phase, not after.

### H6. Weight Versioning (F7)

Add `weights TEXT` (JSON) to `trade_theses` — snapshot the full Alpha Combination weight vector at thesis creation. Post-mortem: "Why did Jarvis take that trade?" requires knowing what weights were active.

```sql
-- Add to trade_theses
weights TEXT,  -- JSON: {"whale_flow": 0.23, "funding": 0.19, "vix": 0.17, ...}
```

Also: `signal_weights_log` table for drift analysis over time.

```sql
CREATE TABLE IF NOT EXISTS signal_weights_log (
  id         INTEGER PRIMARY KEY,
  regime     TEXT NOT NULL,
  weights    TEXT NOT NULL,            -- JSON weight vector
  effective_n REAL,                    -- independent signals count
  ir         REAL,                     -- information ratio
  created_at TEXT DEFAULT (datetime('now'))
);
```

### H7. Per-Layer Freshness Thresholds (F7)

Replace blanket "<24h" with per-layer config:

```typescript
const FRESHNESS_THRESHOLDS = {
  technical: 60 * 60, // 1 hour (price data)
  macro: 7 * 24 * 60 * 60, // 7 days (FRED monthly releases are "fresh" longer)
  crowd: 2 * 60 * 60, // 2 hours (prediction markets move fast)
  smartMoney: 4 * 60 * 60, // 4 hours (whale activity)
  sentiment: 12 * 60 * 60, // 12 hours (fear/greed index updates daily)
};
```

MegaAlpha requires ≥3 layers within their respective freshness windows.

### H8. Dynamic Alert Budget (F9)

Replace static "2-3 signals/day" with regime-aware budget:

| Regime          | Max Alerts/Day | MegaAlpha Threshold              |
| --------------- | -------------- | -------------------------------- |
| Low volatility  | 1-2            | ≥ 0.65                           |
| Normal          | 2-3            | ≥ 0.60                           |
| High volatility | 4-5            | ≥ 0.70 (higher bar during noise) |

Regime detector feeds the alert budget. During crashes, more alerts are allowed but require stronger conviction. During calm, fewer alerts but lower bar — don't miss slow-developing opportunities.

## Constraints

- **Zero new npm deps** for indicators — pure TypeScript math
- **Alpha Vantage premium primary + Yahoo Finance fallback** — never single-source for market data. AV: adjusted daily OHLCV, FX, 50+ server-side indicators, macro economic data, news sentiment. 75 req/min, unlimited daily. Gold via GLD ETF (XAU/USD not supported by AV FX endpoint)
- **Free APIs supplement** — FRED REST API (VIX, ICSA, M2 — 3 series AV doesn't cover), Polymarket/Kalshi (predictions), CoinGecko (crypto), Frankfurter (EUR backup)
- **No Python sidecar** — all data fetching via TypeScript `fetch()`. FRED REST API returns JSON directly. TimesFM deferred to v7.x post-launch enhancement
- **SQLite storage** — 6 tables (market_data, watchlist, backtest_results, trade_theses, api_call_budget, signal_weights_log), additive schema (no DB reset)
- **Minimum signal threshold** — MegaAlpha only generated when ≥3 of 5 signal layers have fresh data (per-layer thresholds, not blanket 24h)
- **Market-native timezones** — Jarvis references markets in their native TZ (ET for US, UTC for crypto, JST for Tokyo). Mexico City for personal scheduling only
- **Text-first delivery** — charts are v7.1, not v7
- **Existing infrastructure** — rituals, proactive scanner, Intel Depot alert router all reusable
- **Scope group** — new `finance` group, deferred tools, keyword-gated
- **Whale tracking scoped** — Polymarket trade history (free, Gamma API) + SEC EDGAR insider filings (free, delayed). No paid whale services
- **Transaction costs in paper trading** — realistic spread/fee model per asset type. Paper P&L after costs
- **Golden-file indicator tests** — every indicator verified against reference to 6 decimal places
- **Realistic session estimate** — 14-15 sessions for F1-F9 (F5 dropped from 1.5 to 0.5 by eliminating Python sidecar). v6 history: 3x expansion is normal. Quality over speed

## Bookmarked Resources

- **TradingView lightweight-charts** — v7.1 chart rendering (50KB, Canvas, OHLC-native)
- **FRED REST API** — macro economic data (500K+ series, free, 120 calls/min). TypeScript fetch for VIX/ICSA/M2 only — other macro from Alpha Vantage
- **Camofox** — if stealth browsing needed for finance site scraping
- **CoinGecko adapter** — already in Intel Depot (src/intel/adapters/coingecko.ts)
- **Frankfurter adapter** — already in Intel Depot (src/intel/adapters/frankfurter.ts)
- **Polymarket Gamma API** — `https://gamma-api.polymarket.com/events` (market discovery, no key)
- **Kalshi REST API** — `https://api.kalshi.com/trade-api/v2` (20 RPS free tier)
- **prediction-market-backtesting** — 9 strategy playbook (mean reversion, EMA crossover, panic fade, VWAP reversion, breakout, RSI reversion, final period momentum, late favorite, threshold). Strategy backtester for F7.5 — Jarvis selects best strategy per regime from historical performance
- **Polymarket-Trading-Bot** — Regime detection (trending/ranging/volatile), multi-filter convergence (7 gates), shadow portfolio validation. Design patterns adopted into F7 composite signals
- **polymarket-paper-trader** — MCP server (29 tools, stdio). Jarvis practices trading with $10K simulated. Track record builds credibility before alerting user. Phase F8
- **polybot** — Replication scoring: compare Jarvis's paper trades vs whale decisions. Measures smart money alignment. Feedback loop for signal tuning
- **Vibe-Trading** (HKUDS) — Gap analysis revealed 3 missing pieces: (1) sentiment signals (fear/greed, funding rates, liquidation heatmaps), (2) stress testing (5 historical + 5 hypothetical crash scenarios), (3) walk-forward ML validation (prevents backtest overfitting). 68-skill reference library. MIT licensed
- **RohOnChain alpha combination thread** — Fundamental Law of Active Management (IR = IC × √N). 11-step procedure for mathematically optimal signal weighting. Replaces naive voting ("3 of 5 agree") with independence-weighted combination. The theoretical foundation for F7. Key insight: 50 weak signals at IC=0.05 beat one strong signal at IC=0.10
- **last30days-skill** (mvanhorn) — Pre-research planner, engagement scoring, cross-source clustering. Free sources: HN (Algolia), Reddit JSON, Bluesky. X via xAI API (~$3-5/mo). 14 platforms, MIT
- **PageIndex** (VectifyAI) — Summary-as-retrieval-key pattern for KB enrichment optimization when >500 entries. Vectorless RAG via LLM tree traversal
- **gbrain** (garrytan) — Compiled truth + timeline for Prometheus goal execution. Tiered goal budgeting. RRF fusion for multi-signal ranking without normalization
- **mcp-toolbox** (Google) — Vector-assist pgvector query generation pattern. Skip adoption (Go server, wrong role)

## Decisions (answered 2026-04-10)

### 1. Sectors: Biotech, Military/Intelligence, Energy

**Initial watchlist:**

| Sector                    | Tickers                                                                                        | Why                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Biotech**               | XBI (SPDR Biotech ETF), IBB (iShares Biotech), ARKG (ARK Genomic), MRNA, LLY, AMGN, VRTX, REGN | FDA approvals, pipeline catalysts, earnings surprises   |
| **Military/Intelligence** | ITA (iShares Defense ETF), LMT, RTX, NOC, GD, PLTR, BA, LHX                                    | Geopolitical tensions, defense budgets, contract awards |
| **Energy**                | XLE (Energy Select ETF), XOP (Oil & Gas Exploration), CVX, XOM, SLB, OXY, FSLR, ENPH           | Oil prices, OPEC decisions, energy transition           |

### 2. Priority: Leveraged FOREX + Gold

**F1 starts with forex/gold, not equities.** Data source: Yahoo Finance for daily OHLCV, Frankfurter (already in Intel Depot) for real-time rates.

| Pair/Instrument    | Why                                              |
| ------------------ | ------------------------------------------------ |
| EUR/USD            | Most liquid, macro-driven                        |
| GBP/USD            | BoE policy divergence                            |
| USD/JPY            | Carry trade barometer                            |
| USD/MXN            | Fede's home currency exposure                    |
| EUR/MXN            | Direct business relevance                        |
| XAU/USD (Gold)     | Safe haven, inflation hedge, central bank buying |
| DXY (Dollar Index) | Umbrella for all USD pairs                       |

**"Leveraged" note:** Jarvis detects signals and paper trades. Position sizing via Kelly accounts for leverage risk. Jarvis never recommends leverage amounts — that's the user's decision.

### 3. FRED API Key

Reminder set: sign up at https://fred.stlouisfed.org/docs/api/api_key.html before F5 session.

### 4. Trading Horizon: Mid-to-Long Term

**No scalping. No intraday noise.**

| Timeframe   | Data                          | Signal Type                                       |
| ----------- | ----------------------------- | ------------------------------------------------- |
| **Daily**   | OHLCV candles, 1 year history | SMA/EMA crossovers, RSI extremes, Bollinger bands |
| **Weekly**  | Aggregated from daily         | Trend direction, regime detection                 |
| **Monthly** | FRED macro data               | Macro regime shifts, yield curve, employment      |

**Alert cadence:** Max 2-3 signals per day across entire watchlist. Morning scan (7:30 AM MX) + end-of-day (4:30 PM MX). No mid-day noise unless a circuit-breaker-level event fires.

**Holding periods:** Days to weeks (forex), weeks to months (sectors). Not minutes or hours.

**Implication for indicators:** Optimize SMA/EMA periods for daily timeframe (20/50/200 day). RSI 14-period on daily. MACD 12/26/9 on daily. No 1-min or 5-min signals.

## Data Source Decision

**Alpha Vantage premium** selected as primary data source. Key set in `.env` as `ALPHAVANTAGE_API_KEY`. Verified 2026-04-11: adjusted daily, FX, macro, server-side indicators, news sentiment all working. 75 req/min, unlimited daily.

| Source               | Role                                                                                                                                                                          | Cost   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Alpha Vantage**    | Forex, stocks (adjusted OHLCV), gold (GLD ETF), macro (fed funds, treasury, CPI, unemployment, payroll, GDP), news sentiment, server-side indicators (golden-file validation) | $50/yr |
| **FRED REST API**    | VIX, initial claims (ICSA), M2 money supply — 3 series AV doesn't cover                                                                                                       | Free   |
| **Polymarket Gamma** | Prediction market probabilities                                                                                                                                               | Free   |
| **CoinGecko**        | Crypto (already in Intel Depot)                                                                                                                                               | Free   |
| **Frankfurter**      | EUR cross-rates backup (already in Intel Depot)                                                                                                                               | Free   |

**Total data layer cost: ~$500/year.**

### Alpha Vantage API Budget (verified 2026-04-11)

**Rate limit:** 75 req/min (sustained at 1/sec, burst-limited at ~5 rapid calls)

| Scenario                              | Instruments                       | Calls/scan                 | Time at 1/sec |
| ------------------------------------- | --------------------------------- | -------------------------- | ------------- |
| Morning OHLCV scan                    | 31 (5 FX + GLD + 24 stocks + DXY) | 31                         | ~31 sec       |
| + Server-side indicators (validation) | 31 × 6 indicators                 | +186                       | ~3.1 min      |
| + Macro refresh                       | 9 (6 AV + 3 FRED)                 | +9                         | ~9 sec        |
| + News sentiment                      | ~5 key tickers                    | +5                         | ~5 sec        |
| **Full morning scan**                 |                                   | **~45** (OHLCV+macro+news) | **~45 sec**   |

Daily capacity: 108,000 calls. Heaviest scenario uses <0.3%.

### Key findings (verified)

- **XAU/USD does NOT work via FX endpoint** — "Invalid API call". Use GLD (SPDR Gold ETF) instead
- **VWAP is intraday only** — irrelevant for daily timeframe, compute locally if needed
- **Server-side indicators** cover 50+ functions (SMA, EMA, RSI, MACD, BBANDS, ATR, etc.) — use for golden-file test validation, not as primary computation
- **Adjusted daily (premium)** includes dividend amount + split coefficient — critical for stock indicator accuracy

## Adopted Patterns from Repo Analysis (Session 58)

### From last30days-skill (mvanhorn/last30days-skill)

**Pre-research planner** — Before searching, an LLM resolves the topic into platform-specific targets (X handles, subreddits, GitHub repos, hashtags). Apply to Jarvis's `exa_search`/`web_search` and v7 intel tools. "Biotech sector sentiment" → specific company names, tickers, X handles, subreddits.

**Engagement-weighted scoring** — Rank results by real-world signals (upvotes, prediction market odds, repost counts) instead of keyword relevance. Maps directly to Alpha Combination Engine signal weighting.

**Cross-source clustering** — Entity overlap detection merges duplicate stories across platforms. Needed for multi-source intel fusion when combining HN + Reddit + X + Polymarket signals.

**New free data sources for v7:**

- Hacker News (Algolia API, zero cost) — tech/biotech sentiment
- Polymarket (Gamma API, zero cost) — already planned in F6
- Reddit public JSON (free for fetching by URL/subreddit)
- Bluesky (AT Protocol, free with app password)

**X/Twitter via xAI API** (~$3-5/mo) — only reliable path. Bird cookie hack is deprecated and fragile. Add as premium intel tier when budget allows.

### From PageIndex (VectifyAI/PageIndex)

**Summary-as-retrieval-key** — When KB exceeds 500 entries (expected in v7 with financial data), add a `summary` column to `kb_entries`. Use summaries for first-pass filtering in enrichment pipeline, fetch full content only when LLM needs it. Reduces the 5K-char enrichment cap pressure without new dependencies.

### From gbrain (garrytan/gbrain)

**Compiled truth + timeline on goal execution** — For Prometheus PER loop: each goal maintains a `compiledState` (current summary, rewritten on replan) + `timeline` (immutable trace of attempts/failures). Reflector reads compiled state instead of re-scanning full trace. Reduces context pressure during multi-iteration financial analysis tasks.

**Tiered goal budgeting** — Allocate API spend by goal importance. High-priority goals (signal detection for user-facing alerts) get more rounds than peripheral goals (data gathering). Apply to orchestrator config in v7 financial tasks where API budget matters.

**RRF (Reciprocal Rank Fusion)** — Merges rankings from different signal types without normalization (K=60). Complement to the 11-step Alpha Combination Engine for cases where signals have incomparable scales (technical price data vs. crowd probability vs. macro regime).

### From googleapis/mcp-toolbox

**Vector-assist query generation** — Auto-generates pgvector similarity SQL from tool config. Apply when v7 financial data queries against pgvector get complex (semantic search across market analysis notes).

### From Awesome-finance-skills (RKiding/Awesome-finance-skills)

**Transmission chain mapping** — Model causal flows on signals: "Gold crash → currency pressure → A-share export tailwind." Each signal gets a `transmission_chain` field — array of `{from, to, mechanism, confidence}`. The Alpha Combination Engine (F7) weights signals by independent contribution but doesn't model _how_ signals transmit through markets. This adds the "why" behind each signal, improving thesis formation.

**Signal evolution tracking** — Systematic lifecycle per signal: `Strengthened`, `Weakened`, or `Falsified` as new data arrives. Integrates with the trade_theses commitment tracking (from PMM pattern). Jarvis tracks whether a thesis is getting stronger or weaker before acting — not just point-in-time snapshots.

**ISQ framework (bookmark)** — 6-dimension decomposition of Information Coefficient: Sentiment, Confidence, Intensity, Expectation Gap, Timeliness, Transmission Clarity. Richer than raw IC as a single number. Apply when Alpha Combination Engine (F7) is built to give each signal a quality profile, not just a weight.

### From persistent-mind-model (scottonanski/persistent-mind-model-v1.0)

**Commitment tracking for trade theses** — MemeGraph lifecycle (open → tracking → resolved/broken) maps to paper trading: thesis formed → trade entered → outcome tracked → thesis resolved or broken. Implementation: `trade_theses` table with status lifecycle, thesis text, evidence array, outcome, extracted lessons.

## Remaining Pre-Build Items

- [x] Alpha Vantage API key — premium tier, set in `.env`, verified 2026-04-11 (adjusted daily, FX, macro, indicators, news sentiment all working)
- [ ] FRED API key signup (before F5 — https://fred.stlouisfed.org/docs/api/api_key.html)
- [ ] 30-day v6 production validation (V7-READINESS-CRITERIA.md checklist — day 2/30, gate ~May 10)
