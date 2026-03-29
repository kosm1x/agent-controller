#!/bin/bash
# Health check → Telegram alert on failure + auto-restart
# Cron: */5 * * * * . /root/claude/mission-control/.env && /root/claude/mission-control/scripts/healthcheck.sh >> /var/log/mc-healthcheck.log 2>&1
#
# Requires: TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID from .env

HC_URL="http://localhost:8080/health"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_OWNER_CHAT_ID:-}"

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "[$(date)] healthcheck: TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set"
  exit 1
fi

send_telegram() {
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
    -d chat_id="$CHAT_ID" -d text="$1" > /dev/null 2>&1
}

RESP=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$HC_URL" 2>/dev/null)

if [ "$RESP" = "200" ]; then
  exit 0
fi

echo "[$(date)] healthcheck: FAILED (HTTP $RESP)"
send_telegram "⚠️ Jarvis health check FAILED (HTTP $RESP). Attempting restart..."

# Attempt auto-restart
systemctl restart mission-control 2>/dev/null
sleep 10

# Verify recovery
RESP2=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$HC_URL" 2>/dev/null)
if [ "$RESP2" = "200" ]; then
  echo "[$(date)] healthcheck: recovered after restart"
  send_telegram "✅ Jarvis recovered after restart."
else
  echo "[$(date)] healthcheck: STILL DOWN (HTTP $RESP2)"
  send_telegram "🔴 Jarvis STILL DOWN after restart (HTTP $RESP2). Manual intervention needed."
fi
