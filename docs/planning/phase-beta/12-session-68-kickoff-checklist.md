# Session 68 — F1 Kickoff Pre-flight Checklist

> **Purpose:** Zero-cognitive-load pre-flight when the 48h readiness window clears. Run top to bottom. If any `❌` emerges, STOP and investigate — do not start F1 with an open gate.
>
> **Earliest start:** 2026-04-17 ~20:00 UTC (48h from the 2026-04-15 19:49 UTC token-refresh restart). The 72h memory observation window closes the same evening.
>
> **Estimated F1 duration:** ~1.85 sessions, ~7h focused work. Mechanical translation of `03-f1-preplan.md`.

---

## Step 0 — Context reload (30 sec)

```bash
cd /root/claude/mission-control
git log --oneline -5                          # confirm last commit is a planning / ops commit, no half-shipped code
git status --short                            # must be clean
cat docs/planning/phase-beta/PHASE-BETA-PLAN.md | head -50
```

Expected: clean working tree, HEAD on `main`, last commit from session 67 ops cleanup or a Tier 1 doc fix.

---

## Step 1 — Gate Dimension 1: Test suite health (2 min)

```bash
npm run typecheck                             # must exit 0
npm test                                      # must pass 2237+/2237+ (may have grown from Tier 1/2 work)
npm test                                      # second run — must pass identically (flake check)
```

**Pass criteria:**

- [ ] Typecheck exits 0
- [ ] Both test runs pass the same count
- [ ] No new `.skip` / `.todo` in `src/runners/`, `src/inference/`, `src/messaging/`

If flake appears → investigate the flaky test. Do not proceed with a flaky suite.

---

## Step 2 — Gate Dimension 2: Production stability (1 min)

```bash
./mc-ctl status                               # service active, 0 restarts, DB/Inference ok
systemctl show mission-control --property=NRestarts,ActiveEnterTimestamp
journalctl -u mission-control --since "48 hours ago" 2>/dev/null | grep -ciE "FATAL|unhandledRejection|uncaughtException"
journalctl -u mission-control --since "48 hours ago" 2>/dev/null | grep -ci invalid_grant
```

**Pass criteria:**

- [ ] `NRestarts=0`
- [ ] `ActiveEnterTimestamp` ≥ 48h old
- [ ] FATAL/unhandled count = `0`
- [ ] `invalid_grant` count = `0` (token still good from 2026-04-15 refresh)
- [ ] Baileys transient `bad-request` on init is acceptable (known WhatsApp upstream noise)

---

## Step 3 — Gate Dimension 3: Audit closure (30 sec)

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^mc-'
```

**Pass criteria:**

- [ ] `mc-grafana` / `mc-prometheus` / `mc-node-exporter` still present (protected by v7.7.4 regex)
- [ ] No runner container older than 6h is present (stale-artifact-prune has fired at least once)
- [ ] v7.9 deferred items (M1 full, M2, M3, W2-W7) have an explicit fix-or-defer decision captured in memory

If the prune has never fired on live host → verify once manually, then proceed.

---

## Step 4 — Gate Dimension 4: Memory + context integrity (1 min)

```bash
./mc-ctl db "SELECT count(*) FROM kb_entries WHERE content LIKE '%used tool%' AND created_at >= datetime('now','-72 hours');"
./mc-ctl db "SELECT count(*) FROM conversations WHERE created_at >= datetime('now','-48 hours');"
./mc-ctl db "SELECT count(*) FROM reflector_gap_log WHERE created_at >= '2026-04-12';"
```

**Pass criteria:**

- [ ] Tool-narrative contamination count in kb_entries = `0` (extractor fix c15a06b holding)
- [ ] Conversations >0 in last 48h (pipeline alive)
- [ ] Reflector gap log >10 rows since 2026-04-12

---

## Step 5 — Gate Dimension 5: External dependency sanity (2 min)

```bash
# Alpha Vantage key present (name is ALPHAVANTAGE_API_KEY — one word, no underscore)
grep -c '^ALPHAVANTAGE_API_KEY=' /root/claude/mission-control/.env

# FRED key present
grep -c '^FRED_API_KEY=' /root/claude/mission-control/.env

# Polygon/Massive key present
grep -c '^POLYGON_API_KEY=\|^MASSIVE_API_KEY=' /root/claude/mission-control/.env

# Google token still good (smoke test)
source /root/claude/mission-control/.env && curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_REFRESH_TOKEN&grant_type=refresh_token" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'access_token' in d else f'FAIL: {d}')"
```

**Pass criteria:**

- [ ] ALPHAVANTAGE_API_KEY → `1`
- [ ] FRED_API_KEY → `1`
- [ ] POLYGON/MASSIVE key → `1`
- [ ] Google token → `OK`

**Reminder:** Watch out for the Alpha Vantage env var spelling. It is `ALPHAVANTAGE_API_KEY` (one word), NOT `ALPHA_VANTAGE_API_KEY`. The F1 adapter must read `process.env.ALPHAVANTAGE_API_KEY`.

---

## Step 6 — Final review of the F1 plan (5 min)

```bash
sed -n '16,105p' docs/planning/phase-beta/03-f1-preplan.md   # 6 locked operator decisions
sed -n '106,260p' docs/planning/phase-beta/03-f1-preplan.md  # schema + adapter interfaces
```

Confirm aloud (or to yourself):

- [ ] Alpha Vantage tier = $49.99/mo
- [ ] Polygon/Massive is the fallback (free tier, 5 req/min)
- [ ] Initial watchlist is the locked default (see Decision 3 — can be edited post-F1 via `watchlist` table)
- [ ] Macro series uses FRED + AV
- [ ] CoinMarketCap Fear & Greed is the sentiment source (F6.5, not F1)
- [ ] γ does NOT interleave β — finish Phase β first
- [ ] 6 additive tables, apply live via `sqlite3 ./data/mc.db < ddl.sql` — NO DB reset

---

## Step 7 — Session 68 opening move

The first 30 minutes of F1 should be exactly this:

1. **DDL apply (60 sec)**

   ```bash
   sqlite3 ./data/mc.db < /tmp/f1-schema.sql   # write the 6 CREATE TABLE IF NOT EXISTS blocks from 03-f1-preplan.md lines 106-235 to /tmp/f1-schema.sql first
   ./mc-ctl db ".schema market_data"            # verify
   ```

2. **AlphaVantageAdapter skeleton** — `src/finance/alpha-vantage.ts` — implement `getDaily(symbol)` only, with the ALPHAVANTAGE_API_KEY env var.

3. **First golden-file test** — write `src/finance/alpha-vantage.test.ts` using the fixture pattern from `__fixtures__/polygon-aggs-spy-daily.json` as a shape template. Mock `fetch`, assert the adapter returns a canonicalized row shape matching `market_data` schema.

4. **Run test** — `npx vitest run src/finance/alpha-vantage` — must pass before writing adapter #2.

**Stop condition for the session:** Adapter + test + schema + one live-mode smoke call to AV that writes a single real row to `market_data`, verified via `./mc-ctl db "SELECT * FROM market_data LIMIT 1"`. Commit, then optionally continue to PolygonAdapter if time allows.

---

## Watchlist bootstrap reminder

F1 needs at least one real symbol in `watchlist` to drive integration tests and the first live fetch. Per operator lock (Decision 3), seed with the locked default. If that list is not yet documented in `03-f1-preplan.md`, the first 15 minutes of F1 must capture it before any adapter code ships.

---

## Abort conditions

Stop F1 and escalate if any of these trigger:

- Test suite flake reappears
- `mc-grafana` or any production container disappears unexpectedly
- Memory pipeline shows contamination after the 72h window
- Alpha Vantage returns 401 / 403 on a warm key (billing issue → resolve before ship)
- Polygon/Massive rebrand causes cascade (fallback the fallback → use only AV for F1 and file an issue)

---

## Post-F1 wrap

Standard wrap protocol: qa-auditor pass → operator merge approval → update `docs/PROJECT-STATUS.md` → save session feedback memory → start S2 (F2 + F4 bundled).
