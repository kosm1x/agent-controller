#!/bin/bash
# Build from source and restart the service, verifying the OLD pid actually
# dies before declaring success. `systemctl restart` is async — MainPID can
# flip to the new process within seconds while the OLD pid keeps serving
# traffic for minutes (observed 2026-04-28: 4-minute overlap window during
# which user messages were eaten by the dying old PID).
# Usage: ./scripts/deploy.sh [--force] [--drain <seconds>]
#   --force         skip in-flight task guard
#   --drain <secs>  wait up to <secs> for running tasks to finish (default 0 = no wait)
set -e
cd /root/claude/mission-control

SERVICE="mission-control"
DB="/root/claude/mission-control/data/mc.db"
TIMEOUT_SECS="${MC_DEPLOY_TIMEOUT_SECS:-300}"  # 2026-05-07 audit W7: bumped from 120s — original incident showed 4-min overlap. Override via env.

FORCE="no"
DRAIN_SECS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE="yes"; shift ;;
    --drain)
      # W2 audit fold: --drain with no value or non-integer would silently
      # decay to 0. Validate up front so a typo is loud, not silent.
      if [[ -z "${2:-}" ]] || [[ ! "$2" =~ ^[0-9]+$ ]]; then
        echo "[deploy] --drain requires a non-negative integer (seconds). Got: '${2:-<missing>}'"
        exit 2
      fi
      DRAIN_SECS="$2"
      shift 2
      ;;
    *) echo "[deploy] unknown arg: $1"; exit 2 ;;
  esac
done

# Migration preflight (2026-07-05 hardening sweep) — the schema-version gate
# (SCHEMA_MIGRATIONS in src/db/index.ts) previously had NO enforcement: an
# engineer had to remember to run scripts/validate-migration-runner.ts. Boot a
# FRESH throwaway DB through initDatabase and assert the expected signature
# (user_version=2, baseline_history dropped). A broken/next migration fails the
# deploy here instead of on the live DB. Cheap (no live-DB copy). Skip only for
# a known-safe emergency deploy via MC_SKIP_MIGRATION_GATE=1.
if [[ "${MC_SKIP_MIGRATION_GATE:-0}" != "1" ]]; then
  echo "[deploy] Migration preflight (fresh-boot schema gate)..."
  MIG_TMP="$(mktemp -d)"
  if npx tsx scripts/validate-migration-runner.ts fresh "$MIG_TMP/fresh.db" > "$MIG_TMP/out.json" 2> "$MIG_TMP/err.log"; then
    if grep -qE '"userVersion": *2' "$MIG_TMP/out.json" && ! grep -q 'baseline_history' "$MIG_TMP/out.json"; then
      echo "[deploy] Migration gate OK — fresh boot → user_version=2, baseline_history absent."
    else
      echo "[deploy] FAILED — fresh-boot schema signature unexpected (want user_version=2, no baseline_history):"
      cat "$MIG_TMP/out.json"
      rm -rf "$MIG_TMP"; exit 1
    fi
  else
    echo "[deploy] FAILED — migration validator errored:"
    cat "$MIG_TMP/err.log"
    rm -rf "$MIG_TMP"; exit 1
  fi
  rm -rf "$MIG_TMP"
fi

echo "[deploy] Building..."
npm run build

# Pre-restart guard — 2026-05-25 fix for the "Service shutdown" recurring
# blocker. Older behaviour just printed a WARN and proceeded; in-flight chats
# died silently. Now we BLOCK on `running` (mid-execution, has side effects)
# unless --force is passed, and optionally drain for --drain N seconds.
# `queued` tasks haven't started yet — they're listed but not blocking
# (boot-time reconciler will still mark them failed; that's a separate
# follow-up to retry-eligible re-queueing).
if [[ -f "$DB" ]]; then
  RUNNING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='running';" 2>/dev/null || echo "0")
  QUEUED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='queued';" 2>/dev/null || echo "0")
  if [[ "${RUNNING:-0}" -gt 0 ]] && [[ "$DRAIN_SECS" -gt 0 ]]; then
    echo "[deploy] $RUNNING task(s) running — draining for up to ${DRAIN_SECS}s..."
    D=0
    while [[ $D -lt $DRAIN_SECS ]]; do
      sleep 2
      D=$((D + 2))
      RUNNING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='running';" 2>/dev/null || echo "0")
      [[ "${RUNNING:-0}" -eq 0 ]] && break
      (( D % 10 == 0 )) && echo "[deploy]   drained ${D}s — still running=$RUNNING"
    done
  fi
  if [[ "${RUNNING:-0}" -gt 0 ]] && [[ "$FORCE" != "yes" ]]; then
    echo "[deploy] BLOCKED — $RUNNING task(s) currently running (queued=$QUEUED):"
    sqlite3 -separator '  ' "$DB" "SELECT task_id, agent_type, substr(title,1,60) FROM tasks WHERE status='running' ORDER BY started_at LIMIT 10;" 2>/dev/null | sed 's/^/  /'
    echo "[deploy] Pass --drain <secs> to wait, or --force to restart anyway. See feedback_check_inflight_tasks_before_restart."
    exit 1
  fi
  if [[ "${RUNNING:-0}" -gt 0 ]]; then
    echo "[deploy] WARN: $RUNNING task(s) still running, --force given — restart will kill them."
  elif [[ "${QUEUED:-0}" -gt 0 ]]; then
    echo "[deploy] note: $QUEUED queued task(s) will be re-failed by boot-time reconciler."
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

  # Post-deploy degradation watch (2026-07-05 sweep): a deploy that boots but
  # immediately errors passes every check above (pid flip + is-active + tool
  # count). Sample the startup window for error/fatal-level log lines and warn
  # loudly — non-fatal (the service IS up; rollback is the operator's call).
  ERR_COUNT=$(journalctl -u "$SERVICE" --since "${ELAPSED} sec ago" --no-pager 2>/dev/null \
    | grep -cE '"level":(50|60)|FATAL|Uncaught|unhandledRejection' || true)
  if [[ "${ERR_COUNT:-0}" -gt 5 ]]; then
    echo "[deploy] ⚠ WARNING — ${ERR_COUNT} error-level log lines in the startup window; service is up but may be degraded."
    echo "[deploy]   Inspect:  journalctl -u $SERVICE --since '2 min ago' | grep -E '\"level\":(50|60)'"
    echo "[deploy]   Rollback: git log --oneline -5 ; git checkout <good-sha> -- . ; MC_SKIP_MIGRATION_GATE=0 ./scripts/deploy.sh"
  else
    echo "[deploy] Post-deploy watch OK — ${ERR_COUNT} error line(s) in startup window."
  fi
else
  echo "[deploy] FAILED — service inactive after PID transition."
  journalctl -u "$SERVICE" --since "${ELAPSED} sec ago" --no-pager | tail -10
  exit 1
fi
