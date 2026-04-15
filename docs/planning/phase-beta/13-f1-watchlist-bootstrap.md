# F1 Watchlist Bootstrap — Adversarial 20-Ticker Test Suite

> **Purpose:** Seed list for F1 bring-up. Each ticker earns its slot by exercising a code path, edge case, or provider divergence in the F1 Data Layer adapters. **Not a trading watchlist** — operator trims/swaps to real trading picks post-F1.
>
> **Referenced by:** `12-session-68-kickoff-checklist.md` Step 6 (Decision 3 unlock) and Step 7 (F1 opening move).
>
> **Coverage target:** all 6 `asset_class` enum values from `market_data` schema CHECK, both price-data adapters (AlphaVantageAdapter + PolygonAdapter), the macro adapter (FredAdapter), all 5 price intervals + 1 monthly, every known symbol-normalization trap, every corporate-action class, and a documented rate-limit stress scenario.

---

## Design principle

This list is **adversarial**. Every slot is justified by a concrete F1 test case, not by trading preference. If a ticker is here, removing it breaks a test. If a test can't be broken by removing any ticker, the list has dead weight and should shrink.

The operator can re-label, re-tag, or set `active=0` on any ticker post-F1 without breaking the Data Layer itself — the `watchlist` table is a dumb working set, not a schema dependency.

---

## The 20

| #   | Symbol   | asset_class | Tags                                     | Adapter path                                    | Role — what it actually tests                                                                                                                                                                                                                                                                            |
| --- | -------- | ----------- | ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SPY`    | `etf`       | `["core","benchmark"]`                   | AV daily + Polygon cross-check                  | **Golden path.** Everything must work on this. First fixture. Used by every integration test as the known-good ticker.                                                                                                                                                                                   |
| 2   | `AAPL`   | `equity`    | `["tech","dividend"]`                    | AV primary                                      | **Dividend adjustment.** Quarterly cash dividends; `adjusted_close ≠ close` on ex-div dates. Asserts AlphaVantageAdapter surfaces `adjusted_close` correctly and `market_data.adjusted_close` column populates.                                                                                          |
| 3   | `MSFT`   | `equity`    | `["tech","dividend"]`                    | AV primary                                      | **Cross-check twin.** Parallel clean-data equity for provider drift tests — fetch via AV, fetch via Polygon, assert close/volume within tolerance.                                                                                                                                                       |
| 4   | `NVDA`   | `equity`    | `["tech","split"]`                       | AV primary                                      | **Recent split.** 10:1 June 2024. Asserts adjusted-vs-raw price divergence on the split date. If the adapter returns un-adjusted prices, this test catches it.                                                                                                                                           |
| 5   | `TQQQ`   | `etf`       | `["leveraged","derivative"]`             | AV primary                                      | **Leveraged ETF decay.** Daily-resetting 3x. Large volume, extreme intraday moves. Tests that signal generation in F3 doesn't compound a decaying product into nonsense.                                                                                                                                 |
| 6   | `SQQQ`   | `etf`       | `["leveraged","inverse"]`                | AV primary                                      | **Inverse signal.** 3x inverse NDX. Negative-correlation pair with TQQQ. Tests that the sign flip propagates correctly through F3 normalization and F6 combination.                                                                                                                                      |
| 7   | `BBIO`   | `equity`    | `["smallcap","biotech"]`                 | AV primary                                      | **Sparse volume + news-driven gaps.** Thin-volume days, binary catalyst events (FDA). Tests gap detection and the adapter's handling of zero-volume holidays vs data holes.                                                                                                                              |
| 8   | `PLUG`   | `equity`    | `["smallcap","volatile"]`                | AV primary                                      | **Volatility extremes + circuit breakers.** Has hit LULD halts repeatedly. Tests that halt-day bars don't poison the time series.                                                                                                                                                                        |
| 9   | `BRK.B`  | `equity`    | `["symbol-edge"]`                        | AV normalizes to `BRK-B`, Polygon keeps `BRK.B` | **THE symbol normalization trap.** AV and Polygon use different dot/dash conventions. Tests `DataLayer` facade's symbol normalization layer. **If any test in F1 fails first, bet on this one.** Also tests the `UNIQUE(symbol, provider, interval, timestamp)` constraint handles both canonical forms. |
| 10  | `GOOG`   | `equity`    | `["tech","class-share","dividend-init"]` | AV primary                                      | **Recent dividend initiation** (April 2024). Tests the adapter handles the regime change from no-dividend to dividend (first real `adjusted_close ≠ close` point in history).                                                                                                                            |
| 11  | `GOOGL`  | `equity`    | `["tech","class-share"]`                 | AV primary                                      | **Class-share dedup negative test.** GOOG and GOOGL are the same issuer, different share classes. The system must NOT dedup them. Asserts both rows co-exist in `market_data`.                                                                                                                           |
| 12  | `META`   | `equity`    | `["tech","dividend-init"]`               | AV primary                                      | **Another dividend initiation** (Feb 2024). Cross-check for #10. If both #10 and #12 fail, the dividend-init detection has a structural bug, not a ticker-specific quirk.                                                                                                                                |
| 13  | `ARM`    | `equity`    | `["ipo-recent"]`                         | AV primary                                      | **Short history edge case.** IPO 2023-09-14. Adapter requesting 5 years of daily data gets ~2.5 years. Tests that the backfill logic handles "history starts mid-range" without NaN-padding or crashing.                                                                                                 |
| 14  | `RDDT`   | `equity`    | `["ipo-recent"]`                         | AV primary                                      | **Cross-check for ARM.** Even shorter history (IPO 2024-03-21). If RDDT backfill fails and ARM passes, it's a date-math boundary (e.g., treats 2024 IPOs differently).                                                                                                                                   |
| 15  | `EURUSD` | `fx`        | `["forex","major"]`                      | AV `FX_DAILY` endpoint                          | **Different AV function path.** Not `TIME_SERIES_DAILY_ADJUSTED`. Tests the adapter routes FX symbols through `FX_DAILY` (which has no volume field). Asserts that the schema's `volume NOT NULL` handles FX by defaulting to 0 or the adapter explicitly sets it.                                       |
| 16  | `GLD`    | `commodity` | `["commodity","gold"]`                   | AV primary (structurally an ETF)                | **asset_class enum coverage.** Ensures 'commodity' is populated. The adapter treats it like any ETF; `asset_class` is behavioral/UX grouping, not structural.                                                                                                                                            |
| 17  | `BTC`    | `crypto`    | `["crypto","btc"]`                       | AV `DIGITAL_CURRENCY_DAILY` endpoint            | **Crypto adapter path.** Tests the adapter routes crypto through the digital-currency function (different response shape, different rate limits, denominated in USD).                                                                                                                                    |
| 18  | `TSM`    | `equity`    | `["adr","tech"]`                         | AV primary (US ADR)                             | **ADR / non-US listing.** Tests that `market_data.timestamp` stays in America/New_York even though the underlying trades on TWSE. Surfaces any timezone-drift bug where the adapter might accidentally use Taipei time.                                                                                  |
| 19  | `VIXCLS` | `macro`     | `["vol","fear"]`                         | **FredAdapter** (not AV)                        | **Cross-adapter path.** Different adapter entirely. Asserts FredAdapter works, that `DataLayer` routes macro symbols to FRED, and that the `provider='fred'` CHECK constraint is satisfied.                                                                                                              |
| 20  | `UNRATE` | `macro`     | `["macro","employment"]`                 | FredAdapter, **monthly frequency**              | **Monthly interval path.** Tests the `interval='monthly'` CHECK constraint + the adapter's ability to request and store a different-cadence series alongside daily equities. If F1's query layer assumes all rows are daily, this breaks it.                                                             |

---

## Coverage matrix

| Dimension                         | Tickers                                                                                             | Why this many                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **asset_class enum (6 values)**   | SPY/TQQQ/SQQQ (etf), GLD (commodity), 12 equities, EURUSD (fx), BTC (crypto), VIXCLS/UNRATE (macro) | Populates every CHECK constraint    |
| **Provider cross-check**          | MSFT + AAPL via AV & Polygon                                                                        | Drift/tolerance test                |
| **Symbol normalization**          | BRK.B                                                                                               | Primary trap                        |
| **Splits**                        | NVDA                                                                                                | Recent & large                      |
| **Dividends — steady**            | AAPL, MSFT                                                                                          | Quarterly                           |
| **Dividends — initiation**        | GOOG, META                                                                                          | Regime change                       |
| **Short history / IPO backfill**  | ARM, RDDT                                                                                           | Two different IPO years             |
| **Sparse/thin data**              | BBIO, PLUG                                                                                          | Gap detection                       |
| **Circuit breakers / LULD**       | PLUG, TQQQ, SQQQ                                                                                    | Halt-day data quality               |
| **Different AV function paths**   | EURUSD (FX_DAILY), BTC (DIGITAL_CURRENCY_DAILY), VIXCLS/UNRATE (FRED adapter)                       | Exercises endpoint routing branches |
| **Timezone discipline**           | TSM (ADR), UNRATE (monthly)                                                                         | Two different timezone risks        |
| **Class shares (dedup negative)** | GOOG + GOOGL                                                                                        | Must NOT dedup                      |
| **Monthly interval**              | UNRATE                                                                                              | Only non-daily ticker               |

---

## Test case recommendations (by file)

### `src/finance/alpha-vantage.test.ts` (~12 cases)

1. Happy path: `SPY` daily → 250 rows shape match against `__fixtures__/alpha-vantage-spy-daily.json`
2. `adjusted_close` divergence on AAPL ex-div day (pick a known ex-div date)
3. `adjusted_close` divergence on NVDA 2024-06-10 split
4. `BRK.B` → AV canonical `BRK-B` → DB stored as `BRK.B`
5. FX routing: `EURUSD` → `FX_DAILY` function, `volume = 0`
6. Crypto routing: `BTC` → `DIGITAL_CURRENCY_DAILY`, USD prices
7. ARM short-history: request 5y, get IPO-to-today without error
8. RDDT even shorter history
9. `AAPL` intraday 5min → 388 bars/day (NYSE)
10. Rate limit simulation: 76 calls in 60s → observes `RateLimitError` + exponential backoff
11. 401 error path via bad key
12. Malformed response (mid-stream cut) → adapter throws typed error, not cascade

### `src/finance/polygon.test.ts` (~8 cases)

1. `SPY` daily → existing `polygon-aggs-spy-daily.json` fixture
2. 401 error → existing `polygon-error-401.json` fixture
3. Cross-check `MSFT` close vs AV within 0.01% tolerance for last 30 days
4. `BRK.B` → Polygon keeps dot; normalization layer receives both forms
5. `NVDA` split boundary — Polygon's adjusted data vs raw
6. Rate limit: 6 calls/min free tier → observe 429, respect `Retry-After`
7. Stale data marker (Polygon returns yesterday's close pre-market) — ensure adapter doesn't store as today
8. `TQQQ` intraday — validates derivative ETF has same shape as underlying

### `src/finance/fred.test.ts` (~5 cases)

1. `VIXCLS` daily series fetch
2. `UNRATE` monthly series — `interval='monthly'` in DB
3. Missing observation (`"."` in FRED response) → converted to NULL, not 0
4. Date range query boundary (inclusive start, exclusive end)
5. 404 for unknown series ID → typed error

### `src/finance/data-layer.test.ts` (the facade — ~10 cases)

1. `getDaily('SPY', ...)` routes to AV first
2. `getDaily('SPY', ...)` with AV down → Polygon fallback, `provider='polygon'` in row
3. `getDaily('VIXCLS', ...)` routes to FRED, never touches AV
4. `getDaily('BRK.B', ...)` returns same data whether caller passes `BRK.B` or `BRK-B` or `BRK/B`
5. `getDaily('GOOG')` and `getDaily('GOOGL')` return disjoint rowsets
6. Asset class inference: `EURUSD` → `fx`, `BTC` → `crypto`, `UNRATE` → `macro`
7. Watchlist refresh over all 20 tickers → no symbol skipped, no duplicate insert
8. Watchlist refresh with one ticker raising → other 19 still persisted, error logged for the one
9. Provider drift detection: MSFT AV vs Polygon close drift > 0.5% → logged as alert-worthy
10. Stale watchlist entry (`active=0`) → not refreshed

### `src/finance/adapter-rate-limit.test.ts` (dedicated, ~4 cases)

1. 20-ticker × 5-interval batch refresh = 100 AV calls. Tests the token-bucket in AlphaVantageAdapter holds the pipeline to 75 req/min without dropping calls.
2. Polygon free tier 5 req/min → burst of 20 requests → correctly serialized with 12s gaps
3. FRED unlimited → no rate limiting logic active on that adapter
4. `api_call_budget` table (per pre-plan) tracks call count per provider per day, decrements correctly

### `src/finance/integration.test.ts` (live-mode, opt-in via `NODE_ENV=integration`)

1. **One real AV call** per adapter with a warm key — validates the key is live and the pricing tier matches expectations. Uses SPY daily, 30-day window.
2. **One real Polygon call** — validates key + endpoint still at `api.massive.com`.
3. **One real FRED call** — validates key.
4. Writes results to `market_data`, `./mc-ctl db "SELECT count(*) FROM market_data"` returns >0.
5. **Does not run in CI** — only manually during F1 kickoff Step 7 ("first live smoke call").

---

## Rate-limit stress scenario

**Scenario:** Operator-triggered full watchlist refresh with intraday + daily + one macro lookup.

- 20 tickers × (`daily` + `5min` + `60min`) = **60 AV calls**
- 2 macro tickers × `daily` = **2 FRED calls**
- 1 cross-check = **1 Polygon call** for MSFT only

**Expected behavior at AV 75 req/min tier:**

- All 60 AV calls complete in a single 60-second window
- `api_call_budget` shows 60/75 consumed, 15 headroom
- Polygon call completes immediately (untouched budget)
- FRED calls complete immediately
- Entire refresh completes in ~75 seconds (includes serialization delay)

**Failure modes this catches:**

- Naive `Promise.all(symbols.map(fetch))` → blows through 75 in 3s, hits 429, partial failure
- Adapter doesn't count FX/crypto calls against the same limit → overcounts budget
- `api_call_budget` row not updated atomically → race condition between parallel fetches

---

## Known gotchas checklist (review before F1 merge)

- [ ] `BRK.B` normalization works in BOTH directions (`.` ↔ `-`)
- [ ] `GOOG` and `GOOGL` are NOT deduped
- [ ] `NVDA` split date produces `close ≠ adjusted_close` on the boundary
- [ ] `ARM` / `RDDT` short history doesn't NaN-pad or crash the backfiller
- [ ] `EURUSD` has `volume=0` not `NULL` (NOT NULL constraint)
- [ ] `BTC` stored with `provider='alpha_vantage'` not a made-up `provider='crypto'`
- [ ] `TSM` timestamps are in America/New_York not Asia/Taipei
- [ ] `UNRATE` stored with `interval='monthly'`, other 19 with `interval='daily'`
- [ ] `VIXCLS` stored with `provider='fred'`, satisfies the schema CHECK constraint
- [ ] Full watchlist refresh is idempotent (re-run populates zero new rows)

---

## Seed DDL (Session 68 kickoff Step 7.1)

Paste into `/tmp/f1-watchlist-seed.sql` after the schema DDL applies:

```sql
INSERT OR REPLACE INTO watchlist (symbol, name, asset_class, tags, active, notes) VALUES
  ('SPY',    'SPDR S&P 500 ETF',              'etf',       '["core","benchmark"]',          1, 'Golden-path baseline'),
  ('AAPL',   'Apple Inc',                      'equity',    '["tech","dividend"]',           1, 'Clean dividend history'),
  ('MSFT',   'Microsoft Corp',                 'equity',    '["tech","dividend"]',           1, 'Provider cross-check twin'),
  ('NVDA',   'NVIDIA Corp',                    'equity',    '["tech","split"]',              1, '10:1 split June 2024'),
  ('TQQQ',   'ProShares UltraPro QQQ',        'etf',       '["leveraged","derivative"]',    1, 'Leveraged ETF decay test'),
  ('SQQQ',   'ProShares UltraPro Short QQQ',  'etf',       '["leveraged","inverse"]',       1, 'Inverse signal test'),
  ('BBIO',   'BridgeBio Pharma',               'equity',    '["smallcap","biotech"]',        1, 'Sparse volume gap test'),
  ('PLUG',   'Plug Power Inc',                 'equity',    '["smallcap","volatile"]',       1, 'LULD halt-day test'),
  ('BRK.B',  'Berkshire Hathaway B',           'equity',    '["symbol-edge"]',               1, 'Dot-ticker normalization trap'),
  ('GOOG',   'Alphabet C',                     'equity',    '["tech","dividend-init"]',      1, 'Dividend initiation April 2024'),
  ('GOOGL',  'Alphabet A',                     'equity',    '["tech","class-share"]',        1, 'Class-share dedup negative test'),
  ('META',   'Meta Platforms',                 'equity',    '["tech","dividend-init"]',      1, 'Dividend initiation Feb 2024'),
  ('ARM',    'Arm Holdings',                   'equity',    '["ipo-recent"]',                1, 'IPO 2023-09 short history'),
  ('RDDT',   'Reddit Inc',                     'equity',    '["ipo-recent"]',                1, 'IPO 2024-03 shorter history'),
  ('EURUSD', 'EUR/USD',                        'fx',        '["forex","major"]',             1, 'FX_DAILY adapter path'),
  ('GLD',    'SPDR Gold Shares',               'commodity', '["commodity","gold"]',          1, 'commodity enum slot'),
  ('BTC',    'Bitcoin',                        'crypto',    '["crypto","btc"]',              1, 'DIGITAL_CURRENCY_DAILY path'),
  ('TSM',    'Taiwan Semiconductor ADR',      'equity',    '["adr","tech"]',                1, 'ADR timezone test'),
  ('VIXCLS', 'CBOE VIX',                       'macro',     '["vol","fear"]',                1, 'FRED adapter test'),
  ('UNRATE', 'US Unemployment Rate',           'macro',     '["macro","employment"]',        1, 'Monthly interval test');
```

**This is a bring-up harness, not a trading universe.** Post-F1 the operator trims/swaps to real trading picks, sets `active=0` on the ones that were only there to stress adapters (TQQQ, SQQQ, BBIO, PLUG if not in the real trading set), and the watchlist becomes the real working set. The `notes` column preserves the "why this ticker is here" for the next operator reading the table.

---

## Cross-references

- `03-f1-preplan.md` — F1 pre-plan, schema (Decision 3 was deferred to this doc)
- `12-session-68-kickoff-checklist.md` Step 6 — kickoff review that pulls these decisions into the first 30 minutes
- `__fixtures__/polygon-aggs-spy-daily.json` + `polygon-error-401.json` — existing F1 fixtures these tests build on
- `V7-ALPHA-COMBINATION-EQUATIONS.md` — F7 pipeline these signals will eventually feed
