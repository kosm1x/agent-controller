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

# Helper: alert once per 24h per state file
maybe_alert() {
  local state_file="$1"
  local msg="$2"
  local now last
  now=$(date +%s)
  last=$(cat "$state_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt 86400 ]; then
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
for svc in mission-control; do
  # A masked/disabled unit is intentionally down — don't fight the operator.
  if ! systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    continue
  fi
  if ! systemctl is-active --quiet "$svc"; then
    systemctl restart "$svc"
    sleep 5
    if systemctl is-active --quiet "$svc"; then
      alert "$svc was down, restarted successfully"
    else
      alert "$svc is DOWN and restart FAILED — manual intervention needed"
    fi
  fi
done

# --- Check 2: MC health endpoint ---
MC_HEALTH=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:8080/health 2>/dev/null || echo "000")
if [ "$MC_HEALTH" != "200" ]; then
  systemctl restart mission-control
  sleep 5
  MC_HEALTH2=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:8080/health 2>/dev/null || echo "000")
  alert "MC health failed (HTTP $MC_HEALTH), restarted. Now: HTTP $MC_HEALTH2"
fi

# --- Checks 3 & 4 (Hindsight health/CPU) REMOVED 2026-06-15 ---
# crm-hindsight container was torn down in the CRM clean-start (Azteca-Aura).
# These blocks curled localhost:8888 and restarted crm-hindsight — they would
# fire/alert forever against a container that no longer exists.

# --- Check 5: Disk usage ---
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
  /root/claude/mission-control/scripts/retention.sh > /dev/null 2>&1 || true
  docker system prune -f > /dev/null 2>&1 || true
  NEW_DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
  alert "Disk at ${DISK_PCT}%, ran cleanup. Now ${NEW_DISK}%"
fi

# --- Check 6 (CRM container prerequisites) REMOVED 2026-06-15 ---
# CRM was undeployed in the Azteca-Aura clean-start. This block used to recreate
# the crm-net network and REBUILD the agent images (crm/container/build.sh),
# which actively fought the teardown — recreating crm-net and re-tagging
# agentic-crm-agent/nanoclaw-agent every 5 min. Intentionally gone.

# --- Check 7: MC DB size (alert-only, NO auto-retention) ---
# Policy (decided 2026-04-24): preserve ALL telemetry for traceability.
# 500 MB is the agreed decision point — when crossed, alert loudly so the
# operator can define a retention policy manually. NEVER auto-delete.
MC_DB=/root/claude/mission-control/data/mc.db
if [ -f "$MC_DB" ]; then
  MC_DB_MB=$(du -m "$MC_DB" | cut -f1)
  if [ "$MC_DB_MB" -ge 500 ]; then
    # Cooldown: only alert once per 24h (state file in /var/lib)
    STATE=/var/lib/mc-watchdog-db-alert
    NOW=$(date +%s)
    LAST=$(cat "$STATE" 2>/dev/null || echo 0)
    if [ $((NOW - LAST)) -gt 86400 ]; then
      alert "mc.db at ${MC_DB_MB} MB — retention decision point reached. Manual policy required (see docs/PROJECT-STATUS.md §retention). No auto-deletion."
      echo "$NOW" > "$STATE"
    fi
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

# --- Check 9: MC observability thresholds (Prometheus-scraped) ---
# Replaces Grafana alerting (stopped) for signals not already covered by earlier checks:
# cost anomaly, provider latency breach, heap pressure. 24h cooldown per sub-alert.
HOURLY_SPEND=$(prom_query "mc_budget_hourly_spend_usd")
HOURLY_LIMIT=$(prom_query "mc_budget_hourly_limit_usd")
HEAP_USED=$(prom_query "mc_nodejs_heap_size_used_bytes")
P95=$(prom_query "max(mc_provider_latency_p95_ms)")

# 9a. Hourly spend > 80% of hourly limit
if [ -n "$HOURLY_SPEND" ] && [ -n "$HOURLY_LIMIT" ]; then
  if awk -v s="$HOURLY_SPEND" -v l="$HOURLY_LIMIT" 'BEGIN{exit !(l>0 && s/l > 0.8)}'; then
    maybe_alert /var/lib/mc-watchdog-hourly-alert \
      "MC hourly spend at \$${HOURLY_SPEND} of \$${HOURLY_LIMIT} limit (>80%) — cost anomaly"
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
