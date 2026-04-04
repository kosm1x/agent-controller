#!/bin/bash
# Morning briefing — sends daily summary to Telegram at 8 AM Mexico City.
# Cron: 0 14 * * * /root/claude/mission-control/scripts/morning-briefing.sh >> /var/log/mc-briefing.log 2>&1

set -euo pipefail

if [ -f /root/claude/mission-control/.env ]; then
  export $(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env | xargs)
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_OWNER_CHAT_ID:-}" ]; then
  echo "Missing Telegram credentials, skipping briefing"
  exit 0
fi

MC_DB="/root/claude/mission-control/data/mc.db"
CRM_DB="/root/claude/crm-azteca/data/store/crm.db"
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

# --- MC Data ---
TASKS_COMPLETED=$(sqlite3 "$MC_DB" "SELECT COUNT(*) FROM tasks WHERE status IN ('completed','completed_with_concerns') AND completed_at >= '${YESTERDAY}' AND completed_at < '${TODAY}';" 2>/dev/null || echo "0")
TASKS_FAILED=$(sqlite3 "$MC_DB" "SELECT COUNT(*) FROM tasks WHERE status = 'failed' AND completed_at >= '${YESTERDAY}' AND completed_at < '${TODAY}';" 2>/dev/null || echo "0")
TASKS_TOTAL=$((TASKS_COMPLETED + TASKS_FAILED))
if [ "$TASKS_TOTAL" -gt 0 ]; then
  SUCCESS_PCT=$(echo "scale=1; $TASKS_COMPLETED * 100 / $TASKS_TOTAL" | bc 2>/dev/null || echo "0")
else
  SUCCESS_PCT="N/A"
fi

COST_YESTERDAY=$(sqlite3 "$MC_DB" "SELECT COALESCE(printf('%.2f', SUM(cost_usd)), '0.00') FROM cost_ledger WHERE created_at >= '${YESTERDAY}' AND created_at < '${TODAY}';" 2>/dev/null || echo "0.00")
TOP_MODEL=$(sqlite3 "$MC_DB" "SELECT COALESCE(model || ' (\$' || printf('%.2f', SUM(cost_usd)) || ')', 'none') FROM cost_ledger WHERE created_at >= '${YESTERDAY}' AND created_at < '${TODAY}' GROUP BY model ORDER BY SUM(cost_usd) DESC LIMIT 1;" 2>/dev/null || echo "none")
CONVERSATIONS=$(sqlite3 "$MC_DB" "SELECT COUNT(*) FROM conversations WHERE created_at >= '${YESTERDAY}';" 2>/dev/null || echo "0")

# --- CRM Data ---
if [ -f "$CRM_DB" ]; then
  CRM_ACTIVITIES=$(sqlite3 "$CRM_DB" "SELECT COUNT(*) FROM actividad WHERE fecha >= '${YESTERDAY}' AND fecha < '${TODAY}';" 2>/dev/null || echo "0")
  CRM_PROPOSALS=$(sqlite3 "$CRM_DB" "SELECT COUNT(*) FROM propuesta WHERE fecha_ultima_actividad >= '${YESTERDAY}';" 2>/dev/null || echo "0")
  PIPELINE_VALUE=$(sqlite3 "$CRM_DB" "SELECT COALESCE(printf('%.1f', SUM(valor_estimado)/1000000.0), '0') FROM propuesta WHERE etapa NOT IN ('completada','perdida','cancelada');" 2>/dev/null || echo "0")
  PIPELINE_COUNT=$(sqlite3 "$CRM_DB" "SELECT COUNT(*) FROM propuesta WHERE etapa NOT IN ('completada','perdida','cancelada');" 2>/dev/null || echo "0")
else
  CRM_ACTIVITIES="N/A"
  CRM_PROPOSALS="N/A"
  PIPELINE_VALUE="0"
  PIPELINE_COUNT="0"
fi

# --- System Data ---
LOAD=$(cat /proc/loadavg | awk '{print $1}')
MEM_FREE=$(free -m | awk '/Mem:/{printf "%.1f", $7/1024}')
UPTIME_DAYS=$(awk '{printf "%.1f", $1/86400}' /proc/uptime)

# --- Hindsight ---
HS_STATUS=$(curl -sf http://localhost:8888/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unreachable")

# --- Alerts fired yesterday ---
ALERTS_FIRED=$(curl -s "http://localhost:9090/api/v1/query?query=ALERTS{alertstate='firing'}" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',{}).get('result',[])))" 2>/dev/null || echo "0")

# --- Build message ---
MSG=$(cat <<EOF
<b>Morning Briefing - ${TODAY}</b>

<b>Tasks:</b> ${TASKS_COMPLETED} completed, ${TASKS_FAILED} failed (${SUCCESS_PCT}%)
<b>Cost:</b> \$${COST_YESTERDAY}
<b>Top model:</b> ${TOP_MODEL}
<b>Memories:</b> ${CONVERSATIONS} new

<b>CRM:</b> ${CRM_ACTIVITIES} activities, ${CRM_PROPOSALS} proposals updated
<b>Pipeline:</b> \$${PIPELINE_VALUE}M across ${PIPELINE_COUNT} proposals

<b>System:</b> load ${LOAD}, ${MEM_FREE}GB free, uptime ${UPTIME_DAYS}d
<b>Alerts firing:</b> ${ALERTS_FIRED}
<b>Hindsight:</b> ${HS_STATUS}
EOF
)

# --- Send ---
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
  -d parse_mode=HTML \
  -d text="$MSG" > /dev/null 2>&1

echo "[$(date)] Briefing sent"
