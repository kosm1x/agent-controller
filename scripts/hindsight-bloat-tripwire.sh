#!/bin/bash
# Hindsight image-size bloat tripwire — fires once at 2026-05-25 18:00 UTC,
# then self-removes from cron.
#
# Checks two signals captured 2026-05-04:
#   - Local disk pressure (baseline 90% / 11 GB free)
#   - Upstream issue vectorize-io/hindsight#1430 ("Image is 26.9 GB; ~16 GB
#     reclaimable on CPU-only deployments") — was the fix accepted?
#
# Classifies as RESOLVED / STEADY / ESCALATE, writes a markdown report,
# Telegrams the headline, and removes itself from the crontab.

set -uo pipefail

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_OWNER_CHAT_ID="${TELEGRAM_OWNER_CHAT_ID:-}"
if [ -f /root/claude/mission-control/.env ]; then
  eval "$(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' /root/claude/mission-control/.env 2>/dev/null || true)"
fi

DATA_DIR=/root/claude/mission-control/data
TODAY=$(date '+%Y-%m-%d')
REPORT="${DATA_DIR}/hindsight-bloat-tripwire-${TODAY}.md"
ISSUE_REPO="vectorize-io/hindsight"
ISSUE_NUMBER=1430
BASELINE_DISK_PCT=90
BASELINE_FREE_GB=11
BASELINE_IMAGE_GB=26.9

mkdir -p "$DATA_DIR"

# ---------- Disk signal ----------
DISK_PCT=$(df / | awk 'NR==2 {gsub("%",""); print $5}')
DISK_FREE=$(df -BG / | awk 'NR==2 {gsub("G",""); print $4}')

# ---------- Hindsight image size ----------
IMAGE_SIZE_BYTES=$(docker image inspect ghcr.io/vectorize-io/hindsight:latest --format '{{.Size}}' 2>/dev/null || echo 0)
IMAGE_SIZE_GB=$(awk -v b="$IMAGE_SIZE_BYTES" 'BEGIN{printf "%.1f", b/1024/1024/1024}')

# ---------- Upstream issue signal ----------
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --repo "$ISSUE_REPO" --json state,comments,closedAt,updatedAt,labels 2>/dev/null || echo '{}')
ISSUE_STATE=$(echo "$ISSUE_JSON" | jq -r '.state // "UNKNOWN"')
ISSUE_COMMENTS=$(echo "$ISSUE_JSON" | jq -r '.comments | length // 0')
ISSUE_UPDATED=$(echo "$ISSUE_JSON" | jq -r '.updatedAt // "n/a"')
ISSUE_LABELS=$(echo "$ISSUE_JSON" | jq -r '[.labels[]?.name] | join(",")')

# ---------- Classification ----------
CLASS="STEADY"
HEADLINE=""
if [ "$DISK_PCT" -ge 95 ]; then
  CLASS="ESCALATE"
  HEADLINE="ESCALATE — disk ${DISK_PCT}% (critical), upstream ${ISSUE_STATE}"
elif [ "$ISSUE_STATE" = "CLOSED" ]; then
  CLASS="RESOLVED"
  HEADLINE="RESOLVED — upstream issue closed; image ${IMAGE_SIZE_GB} GB, disk ${DISK_PCT}%"
elif [ "$DISK_PCT" -lt 85 ] && [ "$ISSUE_COMMENTS" -gt 0 ]; then
  CLASS="RESOLVED"
  HEADLINE="RESOLVED — disk ${DISK_PCT}% (eased), upstream engaged (${ISSUE_COMMENTS} comments)"
elif [ "$DISK_PCT" -ge 90 ] && [ "$ISSUE_COMMENTS" -eq 0 ]; then
  CLASS="ESCALATE"
  HEADLINE="ESCALATE — disk ${DISK_PCT}%, upstream silent (0 comments since ${ISSUE_UPDATED})"
else
  HEADLINE="STEADY — disk ${DISK_PCT}% (baseline 90%), upstream ${ISSUE_STATE} with ${ISSUE_COMMENTS} comments"
fi

# ---------- Report ----------
{
  echo "# Hindsight Bloat Tripwire — ${TODAY}"
  echo
  echo "**Verdict:** ${CLASS}"
  echo
  echo "**Headline:** ${HEADLINE}"
  echo
  echo "## Disk"
  echo
  echo "| Metric | Now | Baseline (2026-05-04) |"
  echo "|---|---|---|"
  echo "| Used %    | ${DISK_PCT}%  | ${BASELINE_DISK_PCT}%  |"
  echo "| Free GB   | ${DISK_FREE}G | ${BASELINE_FREE_GB}G   |"
  echo "| Image GB  | ${IMAGE_SIZE_GB} | ${BASELINE_IMAGE_GB} |"
  echo
  echo "## Upstream issue ${ISSUE_REPO}#${ISSUE_NUMBER}"
  echo
  echo "- State: \`${ISSUE_STATE}\`"
  echo "- Comments: ${ISSUE_COMMENTS}"
  echo "- Labels: \`${ISSUE_LABELS:-none}\`"
  echo "- Last updated: ${ISSUE_UPDATED}"
  echo "- Link: https://github.com/${ISSUE_REPO}/issues/${ISSUE_NUMBER}"
  echo
  echo "## Decision matrix"
  echo
  echo "- **RESOLVED** if upstream closed the issue OR disk eased to <85% with upstream engaged → no action needed."
  echo "- **STEADY** otherwise → keep watching, no fork yet."
  echo "- **ESCALATE** if disk ≥95% OR (disk ≥90% AND upstream silent) → time to fork the Dockerfile (CPU torch + COPY --chown fix)."
} > "$REPORT"

# ---------- Telegram ----------
if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID}" ]; then
  TG_MSG="<b>Hindsight bloat tripwire</b>: ${HEADLINE} | Report: ${REPORT}"
  curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
    -d parse_mode=HTML \
    -d text="$TG_MSG" 2>/dev/null || true
fi

# ---------- Self-remove ----------
crontab -l 2>/dev/null | grep -v 'hindsight-bloat-tripwire.sh' | crontab -

echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): ran (class=${CLASS}, disk=${DISK_PCT}%, upstream=${ISSUE_STATE}/${ISSUE_COMMENTS}c), self-removed from crontab. Report: ${REPORT}"
