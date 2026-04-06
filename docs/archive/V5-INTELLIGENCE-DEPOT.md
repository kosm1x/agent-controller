# v5.0 — Intelligence Depot

> Real-time signal ingestion, delta computation, and predictive alerting for Jarvis.
>
> Slot: v5.0 S6–S8 (after S5 classifier calibration, before multi-user).
> Status: DONE — S6-S8 complete (8 sources, delta engine, alerts, baselines, 4 Jarvis tools, ritual integration).
> Last updated: 2026-04-03

---

## Problem

Jarvis's current signal intelligence is a daily LLM-driven ritual (6 AM cron → exa_search + web_search → score → email digest). This has three structural limitations:

1. **Latency**: Signals arrive at best once/day. A market crash at 2 PM isn't detected until next morning.
2. **No delta awareness**: Each scan is stateless — no comparison against previous state, no detection of _change_.
3. **No prediction surface**: Raw signals are scored by relevance but never accumulated into trend lines or statistical baselines that could flag anomalies before they become obvious.

The intelligence depot solves all three by adding a mechanical, always-on data layer beneath the existing LLM rituals.

---

## Architecture

```
                      ┌─────────────────────────────────────────────┐
                      │              Intelligence Depot              │
                      │                                             │
  External APIs ──────┤  Collectors   →  Signal Store  →  Delta     │
  (30 sources)        │  (adapters)      (SQLite)        Engine     │
                      │                                  │          │
  WebSocket feeds ────┤  Stream Hub   ───────────────────┤          │
  (Finnhub, Bsky)     │  (persistent)                    ▼          │
                      │                              Alert Router   │
                      │                              │    │    │    │
                      │                           FLASH  PRI  RTN  │
                      │                              │    │    │    │
                      └──────────────────────────────┼────┼────┼────┘
                                                     ▼    ▼    ▼
                                              Telegram / Email / SSE
                                              (existing Jarvis tools)
```

### Components

| Component              | Responsibility                                                                                  | New/Existing                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| **Collector adapters** | Normalize external API responses into `Signal` records                                          | New                               |
| **Stream hub**         | Maintain persistent WebSocket connections, emit events                                          | New                               |
| **Signal store**       | SQLite tables for raw signals, snapshots, trends                                                | New (tables in mc.db)             |
| **Delta engine**       | Compare current vs. previous snapshot, compute severity                                         | New (adapted from Crucix pattern) |
| **Alert router**       | Evaluate deltas against thresholds, route to tier (FLASH/PRIORITY/ROUTINE)                      | New                               |
| **Prediction surface** | Statistical baselines + anomaly detection on accumulated signals                                | New                               |
| **Existing rituals**   | Morning briefing, signal intelligence scan — now _consume_ depot data instead of collecting raw | Modified                          |

---

## Data Model

### `signals` table

```sql
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,           -- 'gdelt', 'usgs_earthquake', 'finnhub', etc.
  domain TEXT NOT NULL,           -- 'financial', 'geopolitical', 'cyber', 'weather', etc.
  signal_type TEXT NOT NULL,      -- 'numeric', 'event', 'article', 'alert'
  key TEXT NOT NULL,              -- metric name or event identifier
  value_numeric REAL,            -- for numeric signals (VIX, yields, prices)
  value_text TEXT,               -- for text signals (headlines, descriptions)
  metadata TEXT,                 -- JSON: source-specific fields
  geo_lat REAL,                  -- optional geolocation
  geo_lon REAL,
  content_hash TEXT,             -- SHA-256 of normalized content (dedup)
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_timestamp TEXT          -- original timestamp from the API
);
CREATE INDEX IF NOT EXISTS idx_signals_source_key ON signals(source, key);
CREATE INDEX IF NOT EXISTS idx_signals_domain ON signals(domain, collected_at);
CREATE INDEX IF NOT EXISTS idx_signals_hash ON signals(content_hash);
```

### `signal_snapshots` table (hot state for delta computation)

```sql
CREATE TABLE IF NOT EXISTS signal_snapshots (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  last_value_numeric REAL,
  last_value_text TEXT,
  last_hash TEXT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  run_count INTEGER DEFAULT 1,
  PRIMARY KEY (source, key)
);
```

### `signal_alerts` table

```sql
CREATE TABLE IF NOT EXISTS signal_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier TEXT NOT NULL CHECK (tier IN ('FLASH', 'PRIORITY', 'ROUTINE')),
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  signals_json TEXT NOT NULL,     -- JSON array of signal IDs that triggered this
  delivered_via TEXT,             -- 'telegram', 'email', 'sse'
  content_hash TEXT,             -- dedup hash
  cooldown_until TEXT,           -- suppress duplicate alerts until this time
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_tier ON signal_alerts(tier, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_hash ON signal_alerts(content_hash, cooldown_until);
```

### `signal_baselines` table (for prediction/anomaly detection)

```sql
CREATE TABLE IF NOT EXISTS signal_baselines (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('1h', '6h', '24h', '7d', '30d')),
  mean REAL NOT NULL,
  stddev REAL NOT NULL,
  min_val REAL,
  max_val REAL,
  sample_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, key, window)
);
```

---

## Collector Adapter Interface

Every source implements one contract:

```typescript
interface CollectorAdapter {
  readonly source: string; // unique key: 'gdelt', 'usgs_earthquake', etc.
  readonly domain: string; // 'financial', 'geopolitical', etc.
  readonly defaultInterval: number; // ms between polls (0 = stream-based)

  collect(): Promise<Signal[]>; // fetch + normalize → Signal records

  // Optional: persistent stream connection
  stream?(onSignal: (s: Signal) => void): Promise<() => void>; // returns teardown fn
}

interface Signal {
  source: string;
  domain: string;
  signalType: "numeric" | "event" | "article" | "alert";
  key: string;
  valueNumeric?: number;
  valueText?: string;
  metadata?: Record<string, unknown>;
  geoLat?: number;
  geoLon?: number;
  contentHash?: string;
  sourceTimestamp?: string;
}
```

---

## API Endpoints — Complete Catalog

### Tier 1: Core (12 sources — no auth or trivial signup, highest signal value)

| #   | Source                | Domain       | Endpoint                                                                                                      | Auth                           | Polling | Stream          |
| --- | --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- | --------------- |
| 1   | **GDELT**             | geopolitical | `https://api.gdeltproject.org/api/v2/doc/doc?query=KEYWORD&mode=ArtList&format=json`                          | none                           | 15 min  | -               |
| 2   | **GDELT GKG**         | geopolitical | `http://data.gdeltproject.org/gdeltv2/lastupdate.txt`                                                         | none                           | 15 min  | -               |
| 3   | **USGS Earthquake**   | weather      | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson`                                  | none                           | 5 min   | -               |
| 4   | **NWS Alerts**        | weather      | `https://api.weather.gov/alerts/active?status=actual`                                                         | none (User-Agent)              | 5 min   | -               |
| 5   | **Open-Meteo**        | weather      | `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,wind_speed_10m` | none                           | 60 min  | -               |
| 6   | **Bluesky JetStream** | social       | `wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`                        | none                           | -       | **WS**          |
| 7   | **CISA KEV**          | cyber        | `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`                         | none                           | 6 hr    | -               |
| 8   | **NVD CVE**           | cyber        | `https://services.nvd.nist.gov/rest/json/cves/2.0?lastModStartDate={iso}&lastModEndDate={iso}`                | none (free key for 50 req/30s) | 2 hr    | -               |
| 9   | **Finnhub REST**      | financial    | `https://finnhub.io/api/v1/quote?symbol={sym}&token={key}`                                                    | free-key                       | 15 min  | -               |
| 10  | **Finnhub WS**        | financial    | `wss://ws.finnhub.io?token={key}`                                                                             | free-key                       | -       | **WS** (50 sym) |
| 11  | **CoinGecko**         | financial    | `https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_24hr_change=true`          | none                           | 30 min  | -               |
| 12  | **Frankfurter**       | financial    | `https://api.frankfurter.dev/v1/latest`                                                                       | none                           | daily   | -               |

### Tier 2: High Value (13 sources — free key required, strong data)

| #   | Source               | Domain         | Endpoint                                                                                                                                                | Auth     | Polling | Stream  |
| --- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------- |
| 13  | **FRED**             | economic       | `https://api.stlouisfed.org/fred/series/observations?series_id={id}&api_key={key}&file_type=json`                                                       | free-key | daily   | -       |
| 14  | **Treasury Yields**  | financial      | `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=10`                   | none     | daily   | -       |
| 15  | **BLS**              | economic       | `https://api.bls.gov/publicAPI/v2/timeseries/data/` (POST)                                                                                              | free-key | monthly | -       |
| 16  | **ACLED**            | geopolitical   | `https://api.acleddata.com/acled/read?key={key}&email={email}&event_date={date}&event_date_where=>&limit=500`                                           | free-key | weekly  | -       |
| 17  | **Cloudflare Radar** | infrastructure | `https://api.cloudflare.com/client/v4/radar/traffic_anomalies?dateRange=1d`                                                                             | free-key | 60 min  | -       |
| 18  | **IODA**             | infrastructure | `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/country/{cc}?from={ts}&until={ts}`                                                             | none     | 60 min  | -       |
| 19  | **CelesTrak**        | space          | `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`                                                                                  | none     | 2 hr    | -       |
| 20  | **Safecast**         | nuclear        | `https://api.safecast.org/measurements.json?since={iso}&until={iso}`                                                                                    | none     | 6 hr    | -       |
| 21  | **WHO DON**          | health         | `https://www.who.int/api/news/outbreaks`                                                                                                                | none     | 6 hr    | -       |
| 22  | **disease.sh**       | health         | `https://disease.sh/v3/covid-19/all`                                                                                                                    | none     | 6 hr    | -       |
| 23  | **Delphi Epidata**   | health         | `https://api.delphi.cmu.edu/epidata/covidcast/?data_source=fb-survey&signal=smoothed_cli&geo_type=nation&geo_value=us&time_type=day&time_values={date}` | free-key | daily   | -       |
| 24  | **Google News RSS**  | news           | `https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en`                                                                                | none     | 30 min  | -       |
| 25  | **HN Firebase**      | news           | `https://hacker-news.firebaseio.com/v0/topstories.json`                                                                                                 | none     | -       | **SSE** |

### Tier 3: Supplementary (5 sources — tighter limits, niche value)

| #   | Source          | Domain         | Endpoint                                                              | Auth               | Polling | Stream |
| --- | --------------- | -------------- | --------------------------------------------------------------------- | ------------------ | ------- | ------ |
| 26  | **NewsData.io** | news           | `https://newsdata.io/api/1/latest?apikey={key}&q={query}`             | free-key (200/day) | 60 min  | -      |
| 27  | **OONI**        | infrastructure | `https://api.ooni.io/api/v1/incidents`                                | none               | 6 hr    | -      |
| 28  | **VirusTotal**  | cyber          | `https://www.virustotal.com/api/v3/intelligence/search?query={query}` | free-key (500/day) | 6 hr    | -      |
| 29  | **OilPriceAPI** | financial      | `https://api.oilpriceapi.com/v1/demo/prices`                          | none (demo)        | 60 min  | -      |
| 30  | **EPA RadNet**  | nuclear        | `https://data.epa.gov/efservice/`                                     | none               | daily   | -      |

### Summary: Keys Required

| Key                             | Sources                     | Signup URL                                         |
| ------------------------------- | --------------------------- | -------------------------------------------------- |
| `FINNHUB_API_KEY`               | Finnhub REST + WS           | https://finnhub.io/register                        |
| `FRED_API_KEY`                  | FRED                        | https://fred.stlouisfed.org/docs/api/api_key.html  |
| `NVD_API_KEY`                   | NVD (optional, higher rate) | https://nvd.nist.gov/developers/request-an-api-key |
| `ACLED_API_KEY` + `ACLED_EMAIL` | ACLED                       | https://developer.acleddata.com/                   |
| `BLS_API_KEY`                   | BLS                         | https://data.bls.gov/registrationEngine/           |
| `CLOUDFLARE_API_TOKEN`          | Cloudflare Radar            | https://dash.cloudflare.com/profile/api-tokens     |
| `NEWSDATA_API_KEY`              | NewsData.io                 | https://newsdata.io/register                       |
| `DELPHI_API_KEY`                | Delphi Epidata              | https://cmu-delphi.github.io/delphi-epidata/       |
| `VIRUSTOTAL_API_KEY`            | VirusTotal                  | https://www.virustotal.com/gui/join-us             |

**12 of 30 sources need zero authentication.**

---

## Delta Engine (adapted from Crucix)

The core insight from Crucix worth adapting: define metrics with thresholds, compute change between sweeps, classify severity mechanically.

### Metric Definitions

```typescript
interface MetricDefinition {
  source: string;
  key: string;
  type: "numeric" | "count";
  threshold: number; // % change (numeric) or absolute change (count)
  riskSensitive: boolean; // contributes to risk-on/risk-off calculation
  direction?: "up_is_bad" | "down_is_bad" | "any_change";
}

const METRICS: MetricDefinition[] = [
  // Financial
  {
    source: "finnhub",
    key: "VIX",
    type: "numeric",
    threshold: 10,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "finnhub",
    key: "SPY",
    type: "numeric",
    threshold: 2,
    riskSensitive: true,
    direction: "down_is_bad",
  },
  {
    source: "finnhub",
    key: "DXY",
    type: "numeric",
    threshold: 1,
    riskSensitive: true,
    direction: "any_change",
  },
  {
    source: "coingecko",
    key: "bitcoin",
    type: "numeric",
    threshold: 5,
    riskSensitive: false,
    direction: "any_change",
  },
  {
    source: "frankfurter",
    key: "MXN",
    type: "numeric",
    threshold: 2,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "treasury",
    key: "10Y",
    type: "numeric",
    threshold: 5,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "oilprice",
    key: "WTI",
    type: "numeric",
    threshold: 5,
    riskSensitive: true,
    direction: "up_is_bad",
  },

  // Geopolitical
  {
    source: "gdelt",
    key: "conflict_articles",
    type: "count",
    threshold: 50,
    riskSensitive: true,
  },
  {
    source: "gdelt",
    key: "goldstein_avg",
    type: "numeric",
    threshold: 15,
    riskSensitive: true,
    direction: "down_is_bad",
  },
  {
    source: "acled",
    key: "events_week",
    type: "count",
    threshold: 20,
    riskSensitive: true,
  },

  // Cyber
  {
    source: "cisa_kev",
    key: "new_vulns",
    type: "count",
    threshold: 3,
    riskSensitive: false,
  },
  {
    source: "nvd",
    key: "critical_cves_24h",
    type: "count",
    threshold: 5,
    riskSensitive: false,
  },

  // Natural
  {
    source: "usgs",
    key: "quakes_5plus_24h",
    type: "count",
    threshold: 2,
    riskSensitive: false,
  },
  {
    source: "nws",
    key: "active_warnings",
    type: "count",
    threshold: 10,
    riskSensitive: false,
  },

  // Health
  {
    source: "who",
    key: "new_outbreaks",
    type: "count",
    threshold: 2,
    riskSensitive: false,
  },

  // Infrastructure
  {
    source: "cloudflare",
    key: "anomalies_24h",
    type: "count",
    threshold: 5,
    riskSensitive: false,
  },
  {
    source: "ioda",
    key: "outage_events",
    type: "count",
    threshold: 3,
    riskSensitive: false,
  },
];
```

### Severity Classification

```
change_ratio = abs(current - previous) / threshold

critical  → change_ratio > 3.0
high      → change_ratio > 2.0
moderate  → change_ratio > 1.0
normal    → change_ratio <= 1.0
```

### Market Direction

When multiple risk-sensitive metrics move in the same direction simultaneously:

- **Risk-off**: VIX up + equities down + yields down + gold up → geopolitical or macro fear
- **Risk-on**: VIX down + equities up + yields up → confidence returning
- **Mixed**: conflicting signals → uncertainty, worth monitoring

---

## Alert Routing

### Tier Definitions

| Tier         | Criteria                                                                                         | Cooldown | Delivery                   |
| ------------ | ------------------------------------------------------------------------------------------------ | -------- | -------------------------- |
| **FLASH**    | Any critical-severity delta OR cross-domain correlation (financial + geopolitical both critical) | 1 hour   | Telegram immediate + email |
| **PRIORITY** | Any high-severity delta OR 3+ moderate deltas in same domain within 1 hour                       | 4 hours  | Telegram                   |
| **ROUTINE**  | Moderate deltas, informational signals, trend summaries                                          | 12 hours | Email digest only          |

### Cross-Domain Correlation Rules

These combinations auto-escalate to FLASH regardless of individual severity:

1. Financial critical + Geopolitical critical (war/sanctions → market impact)
2. Cyber critical + Infrastructure critical (coordinated attack)
3. Weather critical + Financial high (natural disaster → supply chain)
4. Health critical + Financial high (pandemic → market)

### Dedup

Content-hash (normalize → strip timestamps → truncate → SHA-256) with a 4-hour dedup window. Prevents flooding when the same event appears across multiple sources.

### Decay-Based Cooldowns

Repeated alerts for the same signal get progressively suppressed:

- 1st alert: immediate
- 2nd (same key, same day): +4 hours
- 3rd: +8 hours
- 4th+: +24 hours

---

## Prediction Surface

### Statistical Baselines

For every numeric metric, maintain rolling baselines at 5 windows: 1h, 6h, 24h, 7d, 30d.

```
z_score = (current - baseline_mean) / baseline_stddev
```

| z-score | Interpretation                                                 |
| ------- | -------------------------------------------------------------- |
| > 3.0   | **Anomaly** — statistically extreme, auto-escalate to PRIORITY |
| > 2.0   | **Unusual** — flag in next digest                              |
| 1.0–2.0 | **Notable** — log, no alert                                    |
| < 1.0   | **Normal** — no action                                         |

### Trend Detection

Over the 7d and 30d windows, compute:

- **Direction**: monotonic increase/decrease over 5+ consecutive samples
- **Acceleration**: rate of change is itself increasing (second derivative)
- **Divergence**: two correlated metrics (e.g., VIX and S&P) moving in unexpected directions simultaneously

Trends are surfaced in the morning briefing digest, not as real-time alerts (too noisy).

### LLM Synthesis (existing infrastructure)

The heavy runner (Prometheus) already handles complex multi-step analysis. For prediction, the depot provides:

1. Raw signal data (last 24h, 7d, 30d)
2. Computed baselines and z-scores
3. Active deltas with severity
4. Trend indicators

The morning briefing ritual is modified to consume this structured data instead of running raw web searches. This makes the LLM's job _interpretation_, not _collection_.

---

## Polling Schedule

```typescript
const SCHEDULE: Record<string, number> = {
  // Real-time (WebSocket — persistent connection, not polling)
  finnhub_ws: 0, // stream
  bluesky_ws: 0, // stream
  hn_sse: 0, // stream

  // High frequency (5 min)
  usgs_earthquake: 5 * 60_000,
  nws_alerts: 5 * 60_000,

  // Medium frequency (15–30 min)
  gdelt: 15 * 60_000,
  coingecko: 30 * 60_000,
  google_news_rss: 30 * 60_000,

  // Hourly
  open_meteo: 60 * 60_000,
  cloudflare_radar: 60 * 60_000,
  ioda: 60 * 60_000,
  newsdata: 60 * 60_000,
  oilprice: 60 * 60_000,

  // Every 2 hours
  nvd_cve: 2 * 60 * 60_000,
  celestrak: 2 * 60 * 60_000,

  // Every 6 hours
  cisa_kev: 6 * 60 * 60_000,
  who_don: 6 * 60 * 60_000,
  disease_sh: 6 * 60 * 60_000,
  safecast: 6 * 60 * 60_000,
  ooni: 6 * 60 * 60_000,
  virustotal: 6 * 60 * 60_000,

  // Daily
  fred: 24 * 60 * 60_000,
  bls: 24 * 60 * 60_000,
  treasury: 24 * 60 * 60_000,
  acled: 24 * 60 * 60_000,
  frankfurter: 24 * 60 * 60_000,
  epa_radnet: 24 * 60 * 60_000,
  delphi: 24 * 60 * 60_000,
};
```

---

## Integration with Existing Jarvis

### Modified Rituals

| Ritual                     | Current                                            | After Depot                                                                                       |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Signal Intelligence (6 AM) | Runs exa_search + web_search → LLM scoring → email | Reads depot signals from last 24h + deltas + baselines → LLM _interprets_ pre-scored data → email |
| Morning Briefing (7 AM)    | General briefing from user_facts                   | Includes depot summary: active deltas, overnight FLASH/PRIORITY alerts, trend indicators          |
| Proactive Scanner (4h)     | Checks overdue tasks, stale objectives             | Also checks: critical deltas not yet acknowledged, trending anomalies                             |

### New Jarvis Tools

| Tool                  | Description                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `intel_query`         | Query the signal store by domain, source, time range, severity. Returns structured signals. |
| `intel_status`        | Current depot status: active streams, last collection times, pending alerts, source health. |
| `intel_alert_history` | Recent alerts with delivery status. Filterable by tier, domain, time range.                 |
| `intel_baseline`      | Retrieve statistical baselines and z-scores for a given metric.                             |

These tools let Jarvis answer questions like "what happened in cyber overnight?" or "is the VIX behaving unusually?" without needing to run a new web search.

### New mc-ctl Commands

```bash
./mc-ctl intel status          # Source health, last poll times, active streams
./mc-ctl intel signals 24h     # Raw signals from last 24h
./mc-ctl intel deltas          # Current active deltas above threshold
./mc-ctl intel alerts          # Recent alerts with tier and delivery status
./mc-ctl intel baseline VIX    # Statistical baselines for a metric
```

---

## Session Breakdown

### S6: Foundation — Adapters + Store + Delta Engine

1. Schema DDL (4 tables)
2. Collector adapter interface + first 5 adapters (USGS, NWS, GDELT, Frankfurter, CISA KEV)
3. Polling scheduler (setInterval-based, per-adapter intervals)
4. Delta engine (metric definitions, severity classification, snapshot diffing)
5. Tests: adapter contract tests, delta computation, snapshot management
6. mc-ctl intel commands (status, signals, deltas)

**Exit criteria**: 5 sources polling, deltas computed and stored, mc-ctl shows data.

### S7: Streaming + Alerts + More Adapters

1. Stream hub (WebSocket manager for Finnhub + Bluesky JetStream)
2. Remaining Tier 1 + Tier 2 adapters (20 more sources)
3. Alert router (tier evaluation, cross-domain correlation, cooldowns, dedup)
4. Alert delivery via existing Telegram + email tools
5. Baseline computation (rolling stats at 5 windows)
6. Tests: stream reconnection, alert tier evaluation, dedup, cooldown decay

**Exit criteria**: 25+ sources active, WebSocket streams persistent, alerts delivered via Telegram.

### S8: Prediction + Ritual Integration

1. Anomaly detection (z-score computation, auto-escalation)
2. Trend detection (direction, acceleration, divergence)
3. Jarvis tools (intel_query, intel_status, intel_alert_history, intel_baseline)
4. Modify signal intelligence ritual to consume depot
5. Modify morning briefing to include depot summary
6. Modify proactive scheduler to check depot alerts
7. Tests: anomaly detection, trend computation, ritual integration

**Exit criteria**: Jarvis can answer "what's unusual right now?" from depot data. Morning briefing includes automated signal summary. Anomalies auto-escalate.

---

## Resource Budget

| Resource | Estimate             | Notes                                                                                  |
| -------- | -------------------- | -------------------------------------------------------------------------------------- |
| Memory   | ~50–100 MB           | Signal store in SQLite, stream buffers for 3 WS connections                            |
| CPU      | Negligible           | All I/O-bound (HTTP fetches, WS reads). Delta math is trivial                          |
| Network  | ~2–5 MB/hour         | 30 sources at various intervals. Bluesky firehose is the biggest (filter aggressively) |
| Disk     | ~10 MB/month         | Signals table with 30-day retention + daily pruning                                    |
| API keys | 9 free registrations | See keys table above. Zero cost                                                        |

### Bluesky Firehose Filtering

The raw firehose is ~50 events/sec. We MUST filter:

- Use JetStream (pre-filtered, JSON) not raw firehose (CBOR)
- Subscribe to `app.bsky.feed.post` only
- Client-side keyword filter: match against active project domains + configurable keyword list
- Drop non-matching posts immediately (don't store)
- Expected: ~1–5 relevant posts/hour after filtering

---

## Risks and Mitigations

| Risk                       | Mitigation                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Source API goes down       | Per-source health tracking. Degraded source doesn't block others (Promise.allSettled). Alert on 3+ consecutive failures |
| Rate limit exhaustion      | Conservative polling intervals (well within free tiers). Exponential backoff on 429                                     |
| Bluesky firehose volume    | JetStream + aggressive keyword filtering. Kill switch if memory exceeds threshold                                       |
| Alert fatigue              | Decay-based cooldowns + strict tier criteria. FLASH should fire <1/week                                                 |
| Stale baselines at startup | First 24h in "learning mode" — collect but don't alert on anomalies until baselines have data                           |
| SQLite write contention    | Batch inserts (one INSERT per collection cycle, not per signal). WAL mode already enabled                               |

---

## What We Took from Crucix

1. **Delta engine pattern**: Metric definitions with thresholds + severity = change_ratio / threshold. Adapted, not copied — our metrics are different and we use SQLite snapshots instead of JSON files.
2. **Multi-tier alert evaluation**: FLASH/PRIORITY/ROUTINE with cross-domain correlation rules and decay-based cooldowns. Adapted the rule structure, rewrote for our alert delivery infrastructure.
3. **Content-hash dedup**: Normalize → strip timestamps/numbers → SHA-256. Prevents duplicate alerts when the same event appears in GDELT, Google News, and Bluesky simultaneously.
4. **Source health tracking**: Count consecutive failures per source, degrade gracefully, alert on persistent failures.

Everything else is original architecture built on Jarvis's existing infrastructure (SQLite, rituals, tools, Telegram/email delivery).
