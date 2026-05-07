#!/bin/bash
# Build from source and restart the service, verifying the OLD pid actually
# dies before declaring success. `systemctl restart` is async — MainPID can
# flip to the new process within seconds while the OLD pid keeps serving
# traffic for minutes (observed 2026-04-28: 4-minute overlap window during
# which user messages were eaten by the dying old PID).
# Usage: ./scripts/deploy.sh
set -e
cd /root/claude/mission-control

SERVICE="mission-control"
DB="/root/claude/mission-control/data/mc.db"
TIMEOUT_SECS=120  # ~max observed slow-shutdown tail; bump if needed

echo "[deploy] Building..."
npm run build

# Pre-flight: warn on running tasks (don't block — operator can override).
if [[ -f "$DB" ]]; then
  RUNNING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='running';" 2>/dev/null || echo "0")
  if [[ "${RUNNING:-0}" -gt 0 ]]; then
    echo "[deploy] WARN: $RUNNING task(s) currently running — restart will kill any in-flight work."
  fi
fi

OLD_PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo "0")
echo "[deploy] Old MainPID=$OLD_PID. Reloading systemd + restarting..."
systemctl daemon-reload
systemctl restart "$SERVICE"

# Wait for: (a) MainPID flipped to a new value, (b) OLD pid actually dead.
# Both required — MainPID often updates within seconds while old process
# continues draining for minutes.
NEW_PID="$OLD_PID"
ELAPSED=0
INTERVAL=2
echo "[deploy] Waiting for old PID to exit..."
while [[ $ELAPSED -lt $TIMEOUT_SECS ]]; do
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
  NEW_PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo "0")
  OLD_DEAD="yes"
  if [[ "$OLD_PID" != "0" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    OLD_DEAD="no"
  fi
  if [[ "$NEW_PID" != "0" && "$NEW_PID" != "$OLD_PID" && "$OLD_DEAD" == "yes" ]]; then
    break
  fi
  if (( ELAPSED % 10 == 0 )); then
    echo "[deploy]   ${ELAPSED}s — newPid=$NEW_PID oldDead=$OLD_DEAD"
  fi
done

if [[ "$NEW_PID" == "0" || "$NEW_PID" == "$OLD_PID" ]]; then
  echo "[deploy] FAILED — MainPID did not change within ${TIMEOUT_SECS}s (oldPid=$OLD_PID, current=$NEW_PID)."
  journalctl -u "$SERVICE" --since "$((TIMEOUT_SECS + 10)) sec ago" --no-pager | tail -15
  exit 1
fi
if [[ "$OLD_PID" != "0" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
  echo "[deploy] FAILED — old PID $OLD_PID still alive after ${TIMEOUT_SECS}s. New PID is $NEW_PID but old is still serving."
  exit 1
fi

if systemctl is-active --quiet "$SERVICE"; then
  TOOLS=$(journalctl -u "$SERVICE" --since '60 sec ago' --no-pager 2>/dev/null | grep -o 'totalTools":[0-9]*' | head -1)
  echo "[deploy] OK — newPid=$NEW_PID (was $OLD_PID), oldPid dead, transition took ${ELAPSED}s. ${TOOLS}"
else
  echo "[deploy] FAILED — service inactive after PID transition."
  journalctl -u "$SERVICE" --since "${ELAPSED} sec ago" --no-pager | tail -10
  exit 1
fi
