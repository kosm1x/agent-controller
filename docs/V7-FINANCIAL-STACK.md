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
│  Macro data (FRED — free, 120 calls/min):                │
│  ├── T10Y2Y (yield curve — recession predictor)          │
│  ├── DFF (fed funds rate — policy stance)                │
│  ├── VIXCLS (VIX — volatility/fear gauge)                │
│  ├── UNRATE, PAYEMS, ICSA (employment signals)           │
│  ├── CPIAUCSL (inflation)                                │
│  ├── M2SL (money supply — liquidity indicator)           │
│  └── Python sidecar via fredapi (no TS port needed)      │
│                                                          │
│  Paid / keyed APIs (optional, higher quality):           │
│  ├── Alpha Vantage (free tier: 25 calls/day)             │
│  ├── Polygon.io (free tier: 5 calls/min, delayed)        │
│  ├── Twelve Data (free tier: 800 calls/day)              │
│  └── Binance WebSocket (real-time crypto, free)          │
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
  source     TEXT DEFAULT 'unknown',  -- 'yahoo', 'coingecko', 'polygon'
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

## Tools (6 new, all deferred)

| Tool                | Purpose                                                    | Scope Group |
| ------------------- | ---------------------------------------------------------- | ----------- |
| `market_quote`      | Current price + daily change for a ticker                  | `finance`   |
| `market_history`    | OHLCV history for a ticker + timeframe                     | `finance`   |
| `market_indicators` | Compute SMA/EMA/RSI/MACD/Bollinger for a ticker            | `finance`   |
| `market_signals`    | Detect active signals across watchlist                     | `finance`   |
| `watchlist_manage`  | Add/remove/list watchlist tickers + alert configs          | `finance`   |
| `market_scan`       | Scan multiple tickers for a specific condition             | `finance`   |
| `macro_dashboard`   | FRED macro regime: yield curve, VIX, employment, inflation | `finance`   |
| `prediction_market` | Polymarket/Kalshi top markets, probabilities, 24h shifts   | `finance`   |

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

## Macro Regime Detection (FRED)

```typescript
// src/finance/macro.ts — Python sidecar via fredapi

interface MacroRegime {
  regime: "expansion" | "tightening" | "recession_risk" | "recovery";
  yieldCurve: number; // T10Y2Y spread (< 0 = inverted)
  fedRate: number; // DFF current level
  vix: number; // VIXCLS current level
  unemployment: number; // UNRATE latest
  inflationYoY: number; // CPIAUCSL year-over-year %
  m2GrowthYoY: number; // M2SL year-over-year %
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

**Integration:** Python sidecar calls fredapi, returns JSON. Cached in SQLite (daily refresh for daily series, monthly for monthly). Macro regime injected into signal context so technical signals get regime-aware interpretation.

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

| Phase    | What                                                        | Sessions | Deps          |
| -------- | ----------------------------------------------------------- | -------- | ------------- |
| **F1**   | market_data table + Yahoo Finance adapter                   | 1        | None          |
| **F2**   | Indicator engine (SMA, EMA, RSI, MACD, Bollinger)           | 1        | F1            |
| **F3**   | Signal detector + market_signals tool                       | 1        | F2            |
| **F4**   | Watchlist management + market_quote/history tools           | 1        | F1            |
| **F5**   | FRED macro regime (Python sidecar + macro_dashboard)        | 1        | None          |
| **F6**   | Prediction markets + whale tracker (Polymarket/Kalshi)      | 1.5      | None          |
| **F6.5** | Sentiment signals (fear/greed, funding rates, liquidations) | 0.5      | None          |
| **F7**   | Alpha Combination Engine (11-step, replaces naive voting)   | 1.5      | F3+F5+F6+F6.5 |
| **F7.5** | Strategy backtester (walk-forward + stress test)            | 1        | F7+F6         |
| **F8**   | Paper trading via pm-trader MCP (Jarvis learns to trade)    | 1        | F7.5          |
| **F9**   | Morning/EOD market scan rituals                             | 1        | F7+F4         |
| **F10**  | Real-time crypto via Binance WebSocket (optional)           | 1        | F3            |
| **v7.1** | Chart rendering (lightweight-charts + Puppeteer → PNG)      | 1        | F3            |

## Constraints

- **Zero new npm deps** for indicators — pure TypeScript math
- **Free APIs first** — Yahoo Finance + CoinGecko + Frankfurter + FRED + Polymarket/Kalshi cover stocks/crypto/forex/macro/predictions
- **Python sidecar for FRED** — fredapi + pandas, called via subprocess. No npm deps added
- **SQLite storage** — market_data table, additive schema (no DB reset)
- **Text-first delivery** — charts are v7.1, not v7
- **Existing infrastructure** — rituals, proactive scanner, Intel Depot alert router all reusable
- **Scope group** — new `finance` group, deferred tools, keyword-gated

## Bookmarked Resources

- **TradingView lightweight-charts** — v7.1 chart rendering (50KB, Canvas, OHLC-native)
- **FRED API (fredapi)** — macro economic data (500K+ series, free, 120 calls/min). Python sidecar
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

## Remaining Pre-Build Items

- [ ] FRED API key signup (before F5)
- [ ] 30-day v6 production validation (V7-READINESS-CRITERIA.md checklist)
- [ ] Confirm Yahoo Finance covers all forex pairs + gold adequately
