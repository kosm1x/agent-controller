#!/bin/bash
# Mission-control state bundle — creates a hot-safe daily snapshot of all
# irreplaceable mission-control state and parks it in /opt/supabase/backups/
# so the PC's nightly rsync (which already pulls that path) carries it offsite.
#
# Cron: 30 2 * * * /root/claude/mission-control/scripts/backup-state-bundle.sh \
#         >> /var/log/mc-state-bundle.log 2>&1
#
# Pull window: ~09:09 UTC daily, so 02:30 UTC gives a 6.5h buffer.

set -euo pipefail

MC_DIR="/root/claude/mission-control"
DEST_DIR="/opt/supabase/backups"
DATE="$(date -u +%Y%m%d)"
STAGE_DIR="$(mktemp -d -t mc-bundle-XXXXXX)"
ARCHIVE="${DEST_DIR}/mission-control-${DATE}.tar.gz"
RETAIN_DAYS=7

trap 'rm -rf "$STAGE_DIR"' EXIT

# Telegram alert (best-effort) for verification failures. Same self-sourcing
# pattern as healthcheck.sh/watchdog.sh — cron's `. .env` doesn't export into here.
eval "$(grep -E '^TELEGRAM_BOT_TOKEN=|^TELEGRAM_OWNER_CHAT_ID=' "${MC_DIR}/.env" 2>/dev/null || true)"
alert() {
  local msg="$1"
  echo "!! $msg"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_OWNER_CHAT_ID:-}" ]; then
    curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
      -d text="🔴 mc state bundle: ${msg}" 2>/dev/null || true
  fi
}

echo "=== $(date -u +%FT%TZ) starting mc state bundle ==="

# Hot-safe SQLite snapshot — uses .backup API, captures WAL atomically.
sqlite3 "${MC_DIR}/data/mc.db" ".backup '${STAGE_DIR}/mc.db'"
echo "  + mc.db snapshot $(du -sh "${STAGE_DIR}/mc.db" | cut -f1)"

# Verify the snapshot is not silently corrupt BEFORE building the archive — a bad
# snapshot of the irreplaceable mc.db must fail loudly, not be discovered at restore.
if ! sqlite3 "${STAGE_DIR}/mc.db" "PRAGMA integrity_check;" | grep -qx ok; then
  alert "mc.db snapshot FAILED PRAGMA integrity_check — snapshot corrupt, aborting bundle"
  exit 1
fi
echo "  + mc.db integrity_check ok"

# Stateful subdirs — anything in data/ that isn't the live DB or rotating backups.
# `archive` = retention archives (deleted task/run history from src/db/retention.ts);
# it is the ONLY copy of that data and otherwise single-disk, so it must go offsite.
for sub in whatsapp-session jarvis graphify reflections archive; do
    src="${MC_DIR}/data/${sub}"
    if [ -d "$src" ]; then
        cp -a "$src" "${STAGE_DIR}/"
        echo "  + ${sub} $(du -sh "${STAGE_DIR}/${sub}" | cut -f1)"
    fi
done

# Critical config — bundled defense-in-depth (the .env is also pulled directly,
# but co-locating ensures the snapshot is self-contained for restore).
for f in mcp-servers.json .env; do
    if [ -f "${MC_DIR}/${f}" ]; then
        cp -a "${MC_DIR}/${f}" "${STAGE_DIR}/"
    fi
done

# Manifest for restore reference.
cat > "${STAGE_DIR}/MANIFEST.txt" <<EOF
mission-control state bundle
created:  $(date -u +%FT%TZ)
host:     $(hostname)
mc-commit: $(git -C "${MC_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)
contents:
$(cd "${STAGE_DIR}" && du -sh -- *)
EOF

# Compress.
tar -czf "$ARCHIVE" -C "$STAGE_DIR" .
echo "  = ${ARCHIVE} $(du -sh "$ARCHIVE" | cut -f1)"

# Verify the archive is readable end-to-end before trusting it as the offsite copy.
# On failure, remove the corrupt archive so it can't masquerade as a fresh backup
# to the watchdog freshness check.
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  alert "archive ${ARCHIVE} failed tar -tzf listing — archive corrupt, removed and aborting"
  rm -f "$ARCHIVE"
  exit 1
fi
echo "  = archive verified (tar -tzf ok)"

# Retention — keep last $RETAIN_DAYS days. Matches Supabase backup policy.
find "$DEST_DIR" -maxdepth 1 -name "mission-control-*.tar.gz" -mtime "+${RETAIN_DAYS}" -delete

echo "=== $(date -u +%FT%TZ) bundle done ==="
