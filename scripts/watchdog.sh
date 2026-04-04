#!/bin/bash
# Self-healing watchdog — checks for known failure modes, auto-remediates.
# Runs every 5 minutes via cron. Alerts via Telegram ONLY when it intervenes.
# Cron: */5 * * * * /root/claude/mission-control/scripts/watchdog.sh >> /var/log/watchdog.log 2>&1

set -euo pipefail

# Load Telegram credentials
if [ -f /root/claude/mission-control/.env ]; then
  export $(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env | xargs)
fi

LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"
ACTIONS=()

alert() {
  local msg="$1"
  ACTIONS+=("$msg")
  echo "$LOG_PREFIX ACTION: $msg"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
      -d parse_mode=HTML \
      -d text="<b>Watchdog</b>: ${msg}" > /dev/null 2>&1 || true
  fi
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
  alert "Mission Control health check failed (HTTP $MC_HEALTH), restarted"
fi

# --- Check 3: Hindsight health ---
HS_HEALTH=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:8888/health 2>/dev/null || echo "000")
if [ "$HS_HEALTH" != "200" ]; then
  docker restart crm-hindsight
  sleep 10
  alert "Hindsight health check failed (HTTP $HS_HEALTH), container restarted"
fi

# --- Check 4: Hindsight CPU ---
HS_CPU=$(docker stats --no-stream --format "{{.CPUPerc}}" crm-hindsight 2>/dev/null | tr -d '%' | cut -d. -f1)
if [ -n "$HS_CPU" ] && [ "$HS_CPU" -gt 95 ] 2>/dev/null; then
  docker restart crm-hindsight
  sleep 10
  alert "Hindsight CPU at ${HS_CPU}%, container restarted"
fi

# --- Check 5: Disk usage ---
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
  # Auto-remediate: run retention + prune docker
  /root/claude/mission-control/scripts/retention.sh > /dev/null 2>&1 || true
  docker system prune -f > /dev/null 2>&1 || true
  NEW_DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
  alert "Disk at ${DISK_PCT}%, ran cleanup. Now ${NEW_DISK}%"
fi

# --- Summary ---
if [ ${#ACTIONS[@]} -eq 0 ]; then
  echo "$LOG_PREFIX OK: all checks passed"
fi
