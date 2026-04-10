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
│              Layer 2: Signal Detection                   │
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
│  └── Kalshi REST API (binary outcome markets, 20 RPS)   │
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
```

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

## Implementation Order

| Phase    | What                                                            | Sessions | Deps     |
| -------- | --------------------------------------------------------------- | -------- | -------- |
| **F1**   | market_data table + Yahoo Finance adapter                       | 1        | None     |
| **F2**   | Indicator engine (SMA, EMA, RSI, MACD, Bollinger)               | 1        | F1       |
| **F3**   | Signal detector + market_signals tool                           | 1        | F2       |
| **F4**   | Watchlist management + market_quote/history tools               | 1        | F1       |
| **F5**   | FRED macro regime (Python sidecar + macro_dashboard)            | 1        | None     |
| **F6**   | Prediction markets (Polymarket/Kalshi + prediction_market tool) | 1        | None     |
| **F7**   | Composite signals (technical + macro + prediction)              | 1        | F3+F5+F6 |
| **F8**   | Morning/EOD market scan rituals                                 | 1        | F7+F4    |
| **F9**   | Real-time crypto via Binance WebSocket (optional)               | 1        | F3       |
| **v7.1** | Chart rendering (lightweight-charts + Puppeteer → PNG)          | 1        | F3       |

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
- **prediction-market-backtesting** — Strategy patterns: mean reversion, EMA crossover, panic fade, VWAP reversion, breakout. Reference for signal extraction logic

## Open Questions

1. **Which tickers does Fede care about?** Need initial watchlist for testing
2. **Alert frequency tolerance?** How many signals/day before it becomes noise?
3. **Crypto priority vs equities?** Determines which data source to build first
4. **Premium data?** Alpha Vantage/Polygon.io API keys worth the cost?
5. **FRED API key?** Free signup at https://fred.stlouisfed.org/docs/api/api_key.html — needed before F5
6. **Prediction market focus?** Fed rate decisions? Elections? Crypto events? Determines Polymarket vs Kalshi priority
