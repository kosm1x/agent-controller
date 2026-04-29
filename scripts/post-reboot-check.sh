#!/bin/bash
# Post-reboot verification — runs once via @reboot cron, then self-removes.
# Captures green/red status of services + containers + endpoints + CRM prereqs.
# Output: /var/log/post-reboot-check.log + Telegram message.

set -uo pipefail

sleep 90  # let services settle

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_OWNER_CHAT_ID="${TELEGRAM_OWNER_CHAT_ID:-}"
if [ -f /root/claude/mission-control/.env ]; then
  eval "$(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env 2>/dev/null || true)"
fi

LOG=/var/log/post-reboot-check.log
{
  echo "=== Post-reboot check at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} > "$LOG"

FAILED=()

KERNEL=$(uname -r)
echo "Kernel: $KERNEL" >> "$LOG"
[ "$KERNEL" = "6.8.0-110-generic" ] || FAILED+=("kernel:$KERNEL!=6.8.0-110-generic")

for svc in mission-control agentic-crm caddy docker; do
  state=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
  echo "service $svc: $state" >> "$LOG"
  [ "$state" = "active" ] || FAILED+=("svc:$svc=$state")
done

EXPECTED="supabase-db supabase-kong supabase-auth supabase-rest supabase-meta supabase-studio supabase-functions crm-hindsight mc-prometheus mc-node-exporter postgres-exporter"
for c in $EXPECTED; do
  status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  echo "container $c: $status" >> "$LOG"
  [ "$status" = "running" ] || FAILED+=("container:$c=$status")
done

check_endpoint() {
  local tag="$1" url="$2"
  local rc
  rc=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo 000)
  echo "endpoint $tag ($url): HTTP $rc" >> "$LOG"
  [ "$rc" = "200" ] || FAILED+=("ep:$tag=$rc")
}
check_endpoint MC http://localhost:8080/health
check_endpoint hindsight http://localhost:8888/health
check_endpoint prom http://localhost:9090/-/healthy

if docker network inspect crm-net >/dev/null 2>&1; then
  echo "crm-net: present" >> "$LOG"
else
  echo "crm-net: missing" >> "$LOG"
  FAILED+=("crm-net:missing")
fi
for img in nanoclaw-agent:latest agentic-crm-agent:latest; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "image $img: present" >> "$LOG"
  else
    echo "image $img: missing" >> "$LOG"
    FAILED+=("img:$img=missing")
  fi
done

ZOMBIES=$(ps -eo state 2>/dev/null | awk '$1=="Z"' | wc -l)
echo "zombies: $ZOMBIES" >> "$LOG"

UPSEC=$(awk '{print int($1)}' /proc/uptime)
echo "uptime: ${UPSEC}s" >> "$LOG"

if [ ${#FAILED[@]} -eq 0 ]; then
  MSG="Post-reboot check: ALL GREEN. Kernel ${KERNEL}, 4 services up, 11 containers running, MC + hindsight + prometheus healthy, CRM prereqs ready, ${ZOMBIES} zombies."
  echo "" >> "$LOG"
  echo "RESULT: ALL GREEN" >> "$LOG"
else
  MSG="Post-reboot check: ${#FAILED[@]} FAILURE(S) on ${KERNEL} — $(IFS='; '; echo "${FAILED[*]}")"
  echo "" >> "$LOG"
  echo "RESULT: ${#FAILED[@]} FAILURE(S)" >> "$LOG"
  printf '  - %s\n' "${FAILED[@]}" >> "$LOG"
fi

if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID}" ]; then
  curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
    -d parse_mode=HTML \
    -d text="<b>Post-reboot</b>: ${MSG}" 2>/dev/null || true
fi

# Self-remove from root crontab so we only run once per reboot trigger
crontab -l 2>/dev/null | grep -v 'post-reboot-check.sh' | crontab -
echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): self-removed from crontab" >> "$LOG"
