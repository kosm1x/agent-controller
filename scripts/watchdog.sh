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
for svc in mission-control agentic-crm; do
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

# --- Check 3: Hindsight health ---
HS_HEALTH=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:8888/health 2>/dev/null || echo "000")
if [ "$HS_HEALTH" != "200" ]; then
  docker restart crm-hindsight 2>/dev/null || true
  sleep 10
  alert "Hindsight health failed (HTTP $HS_HEALTH), container restarted"
fi

# --- Check 4: Hindsight CPU (with timeout to prevent hang on stopped container) ---
HS_CPU=$(timeout 10 docker stats --no-stream --format "{{.CPUPerc}}" crm-hindsight 2>/dev/null | tr -d '%' | cut -d. -f1 || echo "0")
if [ -n "$HS_CPU" ] && [ "$HS_CPU" -gt 95 ] 2>/dev/null; then
  docker restart crm-hindsight 2>/dev/null || true
  sleep 10
  alert "Hindsight CPU at ${HS_CPU}%, container restarted"
fi

# --- Check 5: Disk usage ---
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
  /root/claude/mission-control/scripts/retention.sh > /dev/null 2>&1 || true
  docker system prune -f > /dev/null 2>&1 || true
  NEW_DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
  alert "Disk at ${DISK_PCT}%, ran cleanup. Now ${NEW_DISK}%"
fi

# --- Check 6: CRM container prerequisites (network + images) ---
# CRM's /health stays green even when these are missing — failures only surface
# when a message arrives and docker run spawns an agent. Check proactively.
if ! docker network inspect crm-net >/dev/null 2>&1; then
  if docker network create crm-net >/dev/null 2>&1; then
    alert "crm-net docker network was missing, recreated"
  else
    alert "crm-net docker network missing, recreation FAILED"
  fi
fi

if ! docker image inspect nanoclaw-agent:latest >/dev/null 2>&1 \
   || ! docker image inspect agentic-crm-agent:latest >/dev/null 2>&1; then
  if (cd /root/claude/crm-azteca && ./crm/container/build.sh) >/tmp/crm-rebuild.log 2>&1; then
    systemctl restart agentic-crm 2>/dev/null || true
    alert "CRM agent image(s) missing, rebuilt + service restarted"
  else
    alert "CRM agent image(s) missing, rebuild FAILED — see /tmp/crm-rebuild.log"
  fi
fi

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
    SB_AGE_H=$(( ($(date +%s) - $(stat -c %Y "$SB_LATEST")) / 3600 ))
    SB_SIZE=$(stat -c %s "$SB_LATEST")
    SB_NAME=$(basename "$SB_LATEST")
    STATE=/var/lib/mc-watchdog-sb-alert
    NOW=$(date +%s); LAST=$(cat "$STATE" 2>/dev/null || echo 0)
    if [ "$SB_AGE_H" -gt 36 ]; then
      if [ $((NOW - LAST)) -gt 86400 ]; then
        alert "Supabase latest pg_dump is ${SB_AGE_H}h old (${SB_NAME}, threshold 36h) — 4 AM UTC backup cron may have failed"
        echo "$NOW" > "$STATE"
      fi
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

# --- Summary ---
if [ ${#ACTIONS[@]} -eq 0 ]; then
  echo "$LOG_PREFIX OK: all checks passed"
fi
