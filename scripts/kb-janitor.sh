#!/usr/bin/env bash
#
# kb-janitor.sh — weekly Jarvis KB noise cleanup. Invoked by kb-janitor.timer.
#
# Stops mission-control so the cleanup has exclusive mc.db access and the
# hourly kb-reindex ritual cannot race the deletes, runs the idempotent
# DB-side cleanup, restarts the service, and prunes old janitor backups.
#
# The cleanup itself (cleanup-jarvis-kb.ts) takes its own mc.db + KB-tar
# backup before deleting anything; KEEP_BACKUPS caps how many are retained.
#
set -uo pipefail

PROJECT_DIR=/root/claude/mission-control
SERVICE=mission-control
BACKUP_DIR=/root/backups
KEEP_BACKUPS=4
# Call the local tsx binary directly — `npx tsx` can fall through to a network
# fetch (which can hang) if node_modules is ever pruned. Deterministic here.
TSX=/root/claude/mission-control/node_modules/.bin/tsx

cd "$PROJECT_DIR" || { echo "FATAL: $PROJECT_DIR missing"; exit 1; }
echo "=== kb-janitor $(date -Is) ==="

# Always bring the service back, even if the cleanup aborts.
restart_service() { systemctl start "$SERVICE" 2>/dev/null || true; }
trap restart_service EXIT

echo "[1/3] stopping $SERVICE"
systemctl stop "$SERVICE"

echo "[2/3] running cleanup-jarvis-kb.ts --apply"
CLEAN_RC=0
if [ ! -x "$TSX" ]; then
  echo "FATAL: tsx not found at $TSX — run 'npm install' in $PROJECT_DIR"
  CLEAN_RC=127
else
  "$TSX" scripts/cleanup-jarvis-kb.ts --apply || CLEAN_RC=$?
fi
[ "$CLEAN_RC" -ne 0 ] && echo "WARNING: cleanup exited $CLEAN_RC"

# trap restarts $SERVICE on EXIT

echo "[3/3] pruning old backups (keep $KEEP_BACKUPS)"
for pat in 'mc-db-pre-kbcleanup-*' 'jarvis-kb-pre-kbcleanup-*'; do
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/$pat 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) \
    | xargs -r rm -f
done

echo "=== kb-janitor done $(date -Is) — cleanup rc=$CLEAN_RC ==="
exit "$CLEAN_RC"
