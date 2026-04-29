#!/bin/bash
# Hindsight CPU spike check-up — fires once via cron, then self-removes.
# Compares last 7 days of watchdog Hindsight-CPU restart actions against the
# baseline of 9 restarts/day captured 2026-04-29. Classifies as
# RESOLVED / STEADY / ESCALATE, writes a markdown report, and Telegrams the
# headline. On ESCALATE it also tails docker logs to surface hot patterns.

set -uo pipefail

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_OWNER_CHAT_ID="${TELEGRAM_OWNER_CHAT_ID:-}"
if [ -f /root/claude/mission-control/.env ]; then
  eval "$(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env 2>/dev/null || true)"
fi

DATA_DIR=/root/claude/mission-control/data
WATCHDOG=/var/log/watchdog.log
TODAY=$(date '+%Y-%m-%d')
REPORT="${DATA_DIR}/hindsight-checkup-${TODAY}.md"
BASELINE_PER_DAY=9

mkdir -p "$DATA_DIR"

if [ ! -f "$WATCHDOG" ]; then
  echo "watchdog log missing: $WATCHDOG" >&2
  CLASS="UNKNOWN"
  HEADLINE="Hindsight check-up could not run: $WATCHDOG missing."
  COUNT=0
  PER_DAY="?"
else
  SINCE=$(date -d '7 days ago' '+%Y-%m-%d %H:%M:%S')
  COUNT=$(awk -v since="$SINCE" '
    /ACTION: Hindsight CPU/ {
      ts = substr($0, 2, 19)
      if (ts >= since) c++
    }
    END { print c+0 }
  ' "$WATCHDOG")
  PER_DAY=$(awk -v c="$COUNT" 'BEGIN{ printf "%.1f", c/7 }')

  if awk -v r="$PER_DAY" 'BEGIN{exit !(r < 2)}'; then
    CLASS="RESOLVED"
    HEADLINE="Hindsight CPU spikes look RESOLVED — averaging ${PER_DAY}/day over last 7 days (baseline ${BASELINE_PER_DAY}/day)."
  elif awk -v r="$PER_DAY" 'BEGIN{exit !(r < 5)}'; then
    CLASS="STEADY"
    HEADLINE="Hindsight CPU spikes still occurring but flat — averaging ${PER_DAY}/day over last 7 days (baseline ${BASELINE_PER_DAY}/day)."
  else
    CLASS="ESCALATE"
    HEADLINE="Hindsight CPU spikes escalated — averaging ${PER_DAY}/day over last 7 days (baseline ${BASELINE_PER_DAY}/day)."
  fi
fi

{
  echo "# Hindsight check-up — ${TODAY}"
  echo
  echo "**Status:** ${CLASS}"
  echo "**Last 7 days:** ${COUNT} watchdog restarts on Hindsight CPU >95% (${PER_DAY}/day avg)"
  echo "**Baseline (2026-04-29):** ${BASELINE_PER_DAY}/day"
  echo
  if [ "$CLASS" != "UNKNOWN" ]; then
    echo "## Restart timestamps (last 7 days)"
    echo '```'
    awk -v since="$SINCE" '
      /ACTION: Hindsight CPU/ {
        ts = substr($0, 2, 19)
        if (ts >= since) print
      }
    ' "$WATCHDOG"
    echo '```'
    echo
  fi
} > "$REPORT"

if [ "$CLASS" = "ESCALATE" ]; then
  {
    echo "## Escalation — top patterns from crm-hindsight (last 24h)"
    echo
    echo "Most frequent log lines (timestamps + numbers normalized):"
    echo '```'
    docker logs crm-hindsight --since 24h 2>&1 \
      | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]+//g' \
      | sed -E 's/\b[0-9]+\b/N/g' \
      | sort | uniq -c | sort -rn | head -10
    echo '```'
    echo
    echo "## Recent error/warn/timeout lines"
    echo '```'
    docker logs crm-hindsight --since 24h 2>&1 \
      | grep -iE 'error|warn|fatal|exception|timeout' \
      | tail -20
    echo '```'
    echo
    echo "## Container state right now"
    echo '```'
    docker stats --no-stream crm-hindsight 2>/dev/null
    echo '```'
  } >> "$REPORT"
fi

if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID}" ]; then
  TG_MSG="<b>Hindsight check-up</b>: ${HEADLINE} | Report: ${REPORT}"
  if [ "$CLASS" = "ESCALATE" ]; then
    TG_MSG="${TG_MSG} | Hot patterns surfaced — review report."
  fi
  curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
    -d parse_mode=HTML \
    -d text="$TG_MSG" 2>/dev/null || true
fi

crontab -l 2>/dev/null | grep -v 'hindsight-checkup.sh' | crontab -

echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): ran (class=${CLASS}, count=${COUNT}/7d), self-removed from crontab. Report: ${REPORT}"
