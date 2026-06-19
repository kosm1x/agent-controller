# Self-healing triage monitor

A **read-only** scheduled monitor (`src/lib/self-healing/`). Every 6h it detects
health anomalies, has a Haiku sub-agent root-cause them, and persists a triage
report to `triage_report` — so a problem is **pre-investigated before you open a
session**. It **never remediates**: there is no code path that acts on the
diagnosis (the hard-stop is structural — the only system mutation in the module
is one `INSERT INTO triage_report`).

## What it watches

| Signal             | Source                                         | Threshold                  |
| ------------------ | ---------------------------------------------- | -------------------------- |
| inference degraded | `mc_provider_success_rate` (Prometheus)        | < 0.8                      |
| tool error spike   | `increase(mc_tool_errors_total[10m])`          | > 10                       |
| budget overrun     | `mc_budget_daily_spend_usd`                    | > `BUDGET_DAILY_LIMIT_USD` |
| KB drift           | `mc_kb_reindex_drift`                          | > 10                       |
| messaging flap     | `increase(mc_whatsapp_disconnects_total[15m])` | > 3                        |
| stuck tasks        | `tasks` rows `running` > 30m (SQLite)          | > 3                        |

A metric Prometheus can't answer is **skipped**, never flagged — "unknown" never
manufactures a false alarm. It runs the LLM only when ≥1 anomaly is present AND no
open report already covers the 6h window (the throttle), so cost is bounded
(Haiku, ≤1 call / 6h). Its own spend is recorded to `cost_ledger` as
`agent_type='self-healing-triage'`.

## Run on demand (no arming, no cron)

```bash
cd /root/claude/mission-control
npx tsx scripts/run-triage-monitor.ts          # DRY — list current anomalies (no SDK, no write)
npx tsx scripts/run-triage-monitor.ts --run     # full tick — triage + write a report (burns tokens)
```

## Arm the live cron (deliberate operator step)

Ships **dormant** — the cron only registers when `SELF_HEALING_TRIAGE_ENABLED=true`.
Set it via a **systemd drop-in** (NOT `.env` — systemd `Environment` overrides
dotenv, the V8.2-producer lesson):

```bash
sudo systemctl edit mission-control        # add the two lines below, then save
#   [Service]
#   Environment=SELF_HEALING_TRIAGE_ENABLED=true
sudo systemctl restart mission-control     # or ./scripts/deploy.sh (build + inflight-check + restart + verify)
journalctl -u mission-control --since '1 min ago' | grep -i triage   # expect "registered self-healing triage cron"
```

**Disarm:** `sudo systemctl revert mission-control && sudo systemctl restart mission-control`.

## Read the reports

```bash
./mc-ctl db "SELECT created_at, severity, root_cause, confidence FROM triage_report WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 10;"
# full diagnosis (recommended_actions are OPERATOR-facing — nothing auto-runs them):
./mc-ctl db "SELECT * FROM triage_report ORDER BY created_at DESC LIMIT 1;"
# acknowledge one (clears it from the throttle + the open set):
./mc-ctl db "UPDATE triage_report SET status='acknowledged', acknowledged_at=datetime('now') WHERE report_id='<id>';"
```

## Deploy note

Source edits have no effect until built into `dist/` and the service restarts.
Deploy via `./scripts/deploy.sh` (builds, checks in-flight tasks, restarts,
verifies). The code is safe to deploy **before** arming — dormant until the flag
is set. The `triage_report` table is created additively at DB init even while
dormant (so the harness works), and is boot-safe on the existing `mc.db`.

## Next increments (not built)

- **Delivery**: surface a new high-severity report into the morning brief / a
  Telegram ping (today it persists + logs only — the operator queries it).
- **Deeper root-cause**: a per-layer fan-out sub-agent (logs, recent diffs) for
  the highest-severity anomalies, instead of one analysis pass.
