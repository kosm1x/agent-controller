#!/usr/bin/env bash
#
# run-detached.sh — run a long command so it SURVIVES a panel-terminal / SSH
# disconnect and never loses output to scrollback truncation.
#
# The command runs in its OWN session (immune to the SIGHUP a closing terminal
# sends) with stdin from /dev/null and ALL output (stdout+stderr) streamed to a
# timestamped log. The terminal dropping, or you Ctrl-C'ing your view, never
# stops the command — only your *view* of it. Re-tail or read the log any time.
#
# Usage:
#   scripts/run-detached.sh <command> [args...]        # launch detached, print how to follow
#   scripts/run-detached.sh -f <command> [args...]     # launch detached AND follow the log now
#
# Examples:
#   scripts/run-detached.sh -f ./scripts/deploy.sh                 # deploy, watch live
#   scripts/run-detached.sh ./scripts/deploy.sh                    # deploy, follow later
#   scripts/run-detached.sh -f systemctl restart mission-control   # any long command
#
# Logs land in $RUN_DETACHED_LOG_DIR (default: mission-control/logs/detached).

set -euo pipefail

FOLLOW=0
if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
  FOLLOW=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 [-f|--follow] <command> [args...]" >&2
  exit 2
fi

LOG_DIR="${RUN_DETACHED_LOG_DIR:-/root/claude/mission-control/logs/detached}"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SLUG="$(basename -- "$1" | tr -c 'A-Za-z0-9_.-' '_')"
LOG="$LOG_DIR/${STAMP}-${SLUG}.log"

# Single-quoted so NOTHING here is expanded by THIS shell — bash -c evaluates
# $$, $(date), "$@" at runtime in the detached child. The user's command +
# args arrive as the child's positional params ($1..), so a command with
# spaces/quotes is passed through verbatim (no re-splitting, no injection).
INNER='echo "=== started $(date -Is) (pid $$) ==="
printf "=== cmd:"; printf " %q" "$@"; printf " ===\n"
"$@"
rc=$?
echo "=== finished $(date -Is) rc=$rc ==="
exit $rc'

# setsid = the robust detach (own session, no controlling terminal). Fall back
# to nohup+disown if setsid is somehow absent. </dev/null so it can't block on
# input; output to the log so the panel's scrollback limit is irrelevant.
if command -v setsid >/dev/null 2>&1; then
  setsid bash -c "$INNER" _ "$@" >"$LOG" 2>&1 </dev/null &
else
  nohup bash -c "$INNER" _ "$@" >"$LOG" 2>&1 </dev/null &
fi
PID=$!
disown "$PID" 2>/dev/null || true

cat <<EOF
Detached — keeps running even if this terminal closes.

  pid : $PID
  log : $LOG

Follow live (Ctrl-C / disconnect stops the VIEW, not the command):
  tail -f $LOG

Still running?     kill -0 $PID 2>/dev/null && echo RUNNING || echo DONE
Final result:      tail -n 30 $LOG
EOF

if [[ "$FOLLOW" == "1" ]]; then
  echo "--- following $LOG (Ctrl-C is safe) ---"
  tail -f "$LOG"
fi
