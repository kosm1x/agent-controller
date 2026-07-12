#!/bin/bash
# Self-healing watchdog — checks for known failure modes, auto-remediates.
# Runs every 5 minutes via cron. Alerts via Telegram ONLY when it intervenes.
# Cron: */5 * * * * /root/claude/mission-control/scripts/watchdog.sh >> /var/log/watchdog.log 2>&1

# Lock to prevent concurrent instances
exec 200>/var/lock/watchdog.lock
flock -n 200 || exit 0

set -uo pipefail
# NOTE: not using set -e — we want all checks to run even if one fails

# Load Telegram credentials (grep || true prevents set -u abort on missing pattern)
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_OWNER_CHAT_ID="${TELEGRAM_OWNER_CHAT_ID:-}"
if [ -f /root/claude/mission-control/.env ]; then
  eval "$(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env 2>/dev/null || true)"
fi

LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"
ACTIONS=()

alert() {
  local msg="$1"
  ACTIONS+=("$msg")
  echo "$LOG_PREFIX ACTION: $msg"
  if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID}" ]; then
    local rc
    rc=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
      -d parse_mode=HTML \
      -d text="<b>Watchdog</b>: ${msg}" 2>/dev/null || echo "000")
    if [ "$rc" != "200" ]; then
      echo "$LOG_PREFIX WARNING: Telegram alert failed (HTTP $rc)"
    fi
  fi
}

# Helper: alert at most once per cooldown (default 24h) per state file.
# Optional 3rd arg overrides the cooldown in seconds (e.g. 3600 for hourly).
maybe_alert() {
  local state_file="$1"
  local msg="$2"
  local ttl="${3:-86400}"
  local now last
  now=$(date +%s)
  last=$(cat "$state_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt "$ttl" ]; then
    alert "$msg"
    echo "$now" > "$state_file"
  fi
}

# Helper: scrape a single numeric value from local Prometheus
prom_query() {
  curl -sf --max-time 3 "localhost:9090/api/v1/query?query=$1" 2>/dev/null \
    | jq -r '.data.result[0].value[1] // empty' 2>/dev/null
}

# --- Check 1: Services alive ---
# P2 fix (2026-07-12): NEVER restart on a single probe. On 07-05 and 07-12
# (both at exactly 10:00:01) a transient blip made one probe fail while the
# service was healthy mid-task — the restart killed in-flight work
# (pm_paper_rebalance died mid-run on 07-12). Confirm with a second probe
# 10s later before touching the service.
for svc in mission-control; do
  # A masked/disabled unit is intentionally down — don't fight the operator.
  if ! systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    continue
  fi
  if ! systemctl is-active --quiet "$svc"; then
    echo "$LOG_PREFIX probe 1: $svc not active — re-probing in 10s before restart"
    sleep 10
    if systemctl is-active --quiet "$svc"; then
      echo "$LOG_PREFIX probe 2: $svc active — transient blip, NO restart"
      continue
    fi
    systemctl restart "$svc"
    sleep 5
    if systemctl is-active --quiet "$svc"; then
      alert "$svc was down (2 probes, 10s apart), restarted successfully"
    else
      alert "$svc is DOWN and restart FAILED — manual intervention needed"
    fi
  fi
done

# --- Check 2: MC health endpoint ---
# Same double-probe rule; --max-time so a blocked event loop can't wedge
# curl (the 07-05 HTTP 000 signature).
mc_probe() {
  curl -sf --max-time 10 -o /dev/null -w "%{http_code}" \
    http://localhost:8080/health 2>/dev/null || echo "000"
}
MC_HEALTH=$(mc_probe)
if [ "$MC_HEALTH" != "200" ]; then
  echo "$LOG_PREFIX probe 1: MC health HTTP $MC_HEALTH — re-probing in 10s before restart"
  sleep 10
  MC_HEALTH_RETRY=$(mc_probe)
  if [ "$MC_HEALTH_RETRY" = "200" ]; then
    echo "$LOG_PREFIX probe 2: MC health 200 — transient blip, NO restart"
  else
    systemctl restart mission-control
    sleep 5
    MC_HEALTH2=$(mc_probe)
    alert "MC health failed twice (HTTP $MC_HEALTH then $MC_HEALTH_RETRY, 10s apart), restarted. Now: HTTP $MC_HEALTH2"
  fi
fi

# --- Checks 3 & 4 (Hindsight health/CPU) REMOVED 2026-06-15 ---
# crm-hindsight container was torn down in the CRM clean-start (Azteca-Aura).
# These blocks curled localhost:8888 and restarted crm-hindsight — they would
# fire/alert forever against a container that no longer exists.

# --- Check 5: Disk usage ---
# Real reclaim levers only. scripts/retention.sh was DELETED in Session 104; DB
# retention is now a node cron (src/db/retention.ts), NOT a shell script, so we do
# not try to invoke it here. Levers: vacuum systemd journals, prune Supabase
# pg_dumps past the 7-day retention, and reclaim docker layer/build cache.
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
  journalctl --vacuum-size=200M > /dev/null 2>&1 || true
  find /opt/supabase/backups -maxdepth 1 -name '*.sql.gz' -mtime +7 -delete 2>/dev/null || true
  docker system prune -f > /dev/null 2>&1 || true
  docker buildx prune -f > /dev/null 2>&1 || true
  NEW_DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
  alert "Disk at ${DISK_PCT}%, ran cleanup (journal vacuum→200M, pruned pg_dumps >7d, docker system+buildx prune). Now ${NEW_DISK}%"
fi

# --- Check 6 (CRM container prerequisites) REMOVED 2026-06-15 ---
# CRM was undeployed in the Azteca-Aura clean-start. This block used to recreate
# the crm-net network and REBUILD the agent images (crm/container/build.sh),
# which actively fought the teardown — recreating crm-net and re-tagging
# agentic-crm-agent/nanoclaw-agent every 5 min. Intentionally gone.

# --- Check 7: MC DB size (alert-only, VACUUM reminder) ---
# Retention is AUTOMATED as of 2026-07-05 (src/db/retention.ts node cron
# auto-archives + deletes tasks/runs at 90d) — the old "manual policy required /
# no auto-deletion" alert from 2026-04-24 is obsolete. mc.db no longer grows
# unbounded, but 90d deletes leave dead pages on the SQLite freelist (~77 MB as of
# this writing) that only VACUUM reclaims. When the file crosses 500 MB, remind the
# operator to reclaim via `VACUUM INTO` — the safe hot lever. NEVER auto-VACUUM
# here: it rewrites the whole irreplaceable DB and needs ~2x disk.
MC_DB=/root/claude/mission-control/data/mc.db
if [ -f "$MC_DB" ]; then
  MC_DB_MB=$(du -m "$MC_DB" | cut -f1)
  if [ "$MC_DB_MB" -ge 500 ]; then
    maybe_alert /var/lib/mc-watchdog-db-alert \
      "mc.db at ${MC_DB_MB} MB. Retention auto-prunes tasks/runs at 90d, but freelist dead pages accumulate — reclaim with: sqlite3 ${MC_DB} \"VACUUM INTO '/tmp/mc-vacuumed.db'\" then swap it in during a restart window. No auto-VACUUM (rewrites the whole DB, needs 2x disk)."
  fi
fi

# --- Check 8: Supabase pg_dump freshness ---
# Desktop rsync backup skips Docker volumes — we rely on /opt/supabase/backups/*.sql.gz
# dumps created by the 4 AM UTC cron. If that cron fails silently, the only backup path
# dies. Alert when latest dump is stale (>36h) or suspiciously small (<1 MB).
#
# In-flight handling: backup.sh's `>` redirect creates a 0-byte file at cron-fire instant.
# The */5 watchdog cron races the `0 4` backup cron in the same second, so a naive size
# check tripped daily at 04:00:01. Skip the size check while the latest file is younger
# than 15 min (longest historical pg_dump wall time is ~7 min). A truly-silent cron
# failure still surfaces via the >36h freshness branch on the next day.
SB_DIR=/opt/supabase/backups
if [ -d "$SB_DIR" ]; then
  SB_LATEST=$(find "$SB_DIR" -maxdepth 1 -name '*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -z "$SB_LATEST" ]; then
    STATE=/var/lib/mc-watchdog-sb-alert
    NOW=$(date +%s); LAST=$(cat "$STATE" 2>/dev/null || echo 0)
    if [ $((NOW - LAST)) -gt 86400 ]; then
      alert "Supabase backups dir empty — pg_dump has never run or all dumps were removed"
      echo "$NOW" > "$STATE"
    fi
  else
    SB_AGE_S=$(( $(date +%s) - $(stat -c %Y "$SB_LATEST") ))
    SB_AGE_H=$(( SB_AGE_S / 3600 ))
    SB_SIZE=$(stat -c %s "$SB_LATEST")
    SB_NAME=$(basename "$SB_LATEST")
    STATE=/var/lib/mc-watchdog-sb-alert
    NOW=$(date +%s); LAST=$(cat "$STATE" 2>/dev/null || echo 0)
    if [ "$SB_AGE_H" -gt 36 ]; then
      if [ $((NOW - LAST)) -gt 86400 ]; then
        alert "Supabase latest pg_dump is ${SB_AGE_H}h old (${SB_NAME}, threshold 36h) — 4 AM UTC backup cron may have failed"
        echo "$NOW" > "$STATE"
      fi
    elif [ "$SB_AGE_S" -ge 0 ] && [ "$SB_AGE_S" -lt 900 ]; then
      : # backup likely still writing (file <15min old); next tick re-checks.
      # The `-ge 0` guard prevents a future-dated mtime (clock skew, manual touch)
      # from muting every Check 8 alert forever.
    elif [ "$SB_SIZE" -lt 1048576 ]; then
      if [ $((NOW - LAST)) -gt 86400 ]; then
        alert "Supabase latest pg_dump suspiciously small: ${SB_NAME} is ${SB_SIZE} bytes (expected >=1 MB)"
        echo "$NOW" > "$STATE"
      fi
    fi
  fi
else
  alert "/opt/supabase/backups directory missing — Supabase backup path broken"
fi

# --- Check 8b: MC state bundle freshness ---
# scripts/backup-state-bundle.sh writes mission-control-YYYYMMDD.tar.gz into the
# same /opt/supabase/backups dir at 02:30 UTC daily (the offsite rsync then carries
# it). That bundle is the only offsite copy of irreplaceable Jarvis state (hot mc.db
# snapshot + stateful subdirs + retention archives). Alert if the newest is stale
# (>30h ⇒ missed a daily run) or suspiciously small (<50 MB ⇒ truncated/failed
# snapshot). Young-file (<15min) size check is skipped: tar -czf grows the archive
# in place, the same in-flight race handled in Check 8.
if [ -d "$SB_DIR" ]; then
  MB_LATEST=$(find "$SB_DIR" -maxdepth 1 -name 'mission-control-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -z "$MB_LATEST" ]; then
    maybe_alert /var/lib/mc-watchdog-bundle-alert \
      "MC state bundle missing — no mission-control-*.tar.gz in $SB_DIR. backup-state-bundle.sh (02:30 UTC cron) has never run or all bundles were removed"
  else
    MB_AGE_S=$(( $(date +%s) - $(stat -c %Y "$MB_LATEST") ))
    MB_AGE_H=$(( MB_AGE_S / 3600 ))
    MB_SIZE=$(stat -c %s "$MB_LATEST")
    MB_NAME=$(basename "$MB_LATEST")
    if [ "$MB_AGE_H" -gt 30 ]; then
      maybe_alert /var/lib/mc-watchdog-bundle-alert \
        "MC state bundle is ${MB_AGE_H}h old (${MB_NAME}, threshold 30h) — 02:30 UTC backup-state-bundle cron may have failed"
    elif [ "$MB_AGE_S" -ge 0 ] && [ "$MB_AGE_S" -lt 900 ]; then
      : # bundle likely still writing (file <15min old); next tick re-checks.
    elif [ "$MB_SIZE" -lt 52428800 ]; then
      maybe_alert /var/lib/mc-watchdog-bundle-alert \
        "MC state bundle suspiciously small: ${MB_NAME} is ${MB_SIZE} bytes (expected >=50 MB) — snapshot may be truncated"
    fi
  fi
fi

# --- Check 8c: mc-prometheus container liveness ---
# Every Prometheus-scraped check below (9a cost, 9b heap, 9c latency) silently
# no-ops when localhost:9090 is unreachable, so a dead mc-prometheus blinds the
# watchdog with no alert. Surface it explicitly. Alert-only (no auto-restart) —
# `docker restart mc-prometheus` is the operator lever.
PROM_RUNNING=$(docker inspect -f '{{.State.Running}}' mc-prometheus 2>/dev/null || echo "missing")
if [ "$PROM_RUNNING" != "true" ]; then
  maybe_alert /var/lib/mc-watchdog-prometheus-alert \
    "mc-prometheus container is not running (state: ${PROM_RUNNING}) — all Prometheus-based watchdog checks (cost/heap/latency) are blind. Restart: docker restart mc-prometheus"
fi

# --- Check 9: MC observability thresholds (Prometheus-scraped) ---
# Replaces Grafana alerting (stopped) for signals not already covered by earlier checks:
# cost anomaly, provider latency breach, heap pressure. 24h cooldown per sub-alert.
HOURLY_SPEND=$(prom_query "mc_budget_hourly_spend_usd")
HOURLY_LIMIT=$(prom_query "mc_budget_hourly_limit_usd")
HEAP_USED=$(prom_query "mc_nodejs_heap_size_used_bytes")
P95=$(prom_query "max(mc_provider_latency_p95_ms)")

# 9a. Hourly spend near/at the hourly cap (>=95%). The hourly limit hard-binds
# (~$2), so brushing 80% is routine operation, not an anomaly — only a nearly
# exhausted hourly budget signals a genuine retry-storm / runaway. Mute is 1h (not
# the 24h default) so a real second-hour spike re-surfaces instead of being folded
# into one daily ping; it still won't cry wolf every 5-minute tick.
if [ -n "$HOURLY_SPEND" ] && [ -n "$HOURLY_LIMIT" ]; then
  if awk -v s="$HOURLY_SPEND" -v l="$HOURLY_LIMIT" 'BEGIN{exit !(l>0 && s/l >= 0.95)}'; then
    maybe_alert /var/lib/mc-watchdog-hourly-alert \
      "MC hourly spend \$${HOURLY_SPEND} of \$${HOURLY_LIMIT} limit (>=95%, hourly budget nearly exhausted) — cost anomaly / possible retry-storm" \
      3600
  fi
fi

# 9b. Heap used > 500 MB (absolute, not ratio — Node total grows dynamically)
if [ -n "$HEAP_USED" ]; then
  HEAP_MB=$(awk -v b="$HEAP_USED" 'BEGIN{print int(b/1048576)}')
  if [ "$HEAP_MB" -gt 500 ]; then
    maybe_alert /var/lib/mc-watchdog-heap-alert \
      "MC Node.js heap at ${HEAP_MB} MB (threshold 500 MB) — possible leak, investigate"
  fi
fi

# 9c. Provider p95 latency > 30s
if [ -n "$P95" ]; then
  P95_INT=$(awk -v p="$P95" 'BEGIN{print int(p)}')
  if [ "$P95_INT" -gt 30000 ]; then
    maybe_alert /var/lib/mc-watchdog-latency-alert \
      "MC provider p95 latency ${P95_INT}ms (threshold 30000ms) — inference degraded"
  fi
fi

# 9d. Ritual-loop wedge, detected OUT-OF-BAND (2026-07-10, hardening-sweep
# residual). The in-process poller heartbeat stamps
# mc_ritual_last_success_timestamp every 2 min, and MCRitualLoopStale +
# schedule.run_failed→Telegram cover in-process failures — but their DELIVERY
# rides the same process that could be wedged. min staleness across rituals =
# time() - max(timestamp): if even the freshest ritual heartbeat is >30 min
# old, the scheduler loop (or its event loop) is stuck, and only this external
# path can say so. Metric absent → skip (Checks 1/8c cover a dead service or
# dead Prometheus).
RITUAL_FRESHEST_AGE=$(prom_query "time()%20-%20max(mc_ritual_last_success_timestamp)")
if [ -n "$RITUAL_FRESHEST_AGE" ]; then
  RITUAL_AGE_INT=$(awk -v a="$RITUAL_FRESHEST_AGE" 'BEGIN{print int(a)}')
  if [ "$RITUAL_AGE_INT" -gt 1800 ]; then
    maybe_alert /var/lib/mc-watchdog-ritual-wedge-alert \
      "MC ritual loop wedged: freshest ritual success is ${RITUAL_AGE_INT}s old (threshold 1800s; the */2min poller heartbeat should stamp continuously) — scheduler/event-loop stuck, restart mission-control"
  fi
fi

# --- Check 10: Disk soft-cap (alert-only forecasting) ---
# Budget: 200 GB hard / 150 GB soft. Fires before Check 5 (90% / 174 GB) so the
# operator gets a months-out heads-up to trim, not a panic alarm.
DISK_USED_GB=$(df -BG / | tail -1 | awk '{print $3}' | tr -d 'G')
if [ "$DISK_USED_GB" -ge 150 ]; then
  TOP=$(du -sh /var/lib/docker /opt/supabase/backups /root/claude/mission-control/data 2>/dev/null | awk '{printf "%s=%s ", $2, $1}')
  maybe_alert /var/lib/mc-watchdog-disk-soft-alert \
    "Disk at ${DISK_USED_GB} GB (soft cap 150 / hard 200). Trim time. Top: ${TOP}"
fi

# --- Summary ---
if [ ${#ACTIONS[@]} -eq 0 ]; then
  echo "$LOG_PREFIX OK: all checks passed"
fi
