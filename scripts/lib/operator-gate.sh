#!/usr/bin/env bash
# S6 queue item 3c — bash twin of src/lib/operator-gate.ts (same regexes).
# Operator-only shell entry points (mc-ctl RW subcommands, scripts/deploy.sh)
# refuse outside an operator context: a login session scope, or one of the
# systemd units that run operator scripts unattended. Tasks run inside
# mission-control.service and are refused. No env or flag override.
# Sourced by mc-ctl and scripts/deploy.sh.

_OPERATOR_SESSION_RE='^0::/user\.slice/user-[0-9]+\.slice/session-[0-9]+\.scope$'
# Not cron / recall-checkpoint / post-reboot-verify: they run task-writable code.
_OPERATOR_UNIT_RE='^0::/system\.slice/(v81-gate-check|v82-shadow-verdict|kb-janitor)\.service$'
_OPERATOR_TASK_RE='^0::/system\.slice/mission-control\.service$'

# mc-ctl subcommands that write (db, data/, KB, .env, services, containers)
# or call a gated script. An entry is a whole command ("restart") or
# "<command> <sub>" ("skills certify"). Read by mc-ctl's router and pinned by
# src/lib/operator-gate.lock.test.ts; src/tools/builtin/shell.ts denies each.
# `db` is not listed: cmd_db opens read-only outside an operator context (V8.4
# gate checks run `mc-ctl db "SELECT …"` from tasks) and gates its shell.
# `validation` is not listed: its SQL runs through the read-only helpers and its
# one write is the data/v7-validation.log append (cron runs it daily).
GATED_SUBCOMMANDS=(
  start stop restart cancel schedule-delete schedule-resume hindsight-restart
  audit-claim jme-dedup briefing-gate v83-gate v83-promote rule-of-two
  project-create judgments close-phase resume task-resume audit-closure smoke
  "skills backfill-embeddings" "skills retrieve" "skills certify" "skills archive" "skills revert"
  "jme-preferences --confirm" "jme-preferences --reject"
  "events retrieve" "events aggregate" "events seed"
  "cohort rollup" "gates set-ritual"
  "mcp-token create" "mcp-token revoke"
  "monitoring up" "monitoring down"
)

# Pure: prints why this context may not run an operator-only entry point
# (nothing when allowed). $1 = /proc/self/cgroup text, $2 = 1 when stdin and
# stdout are TTYs, $3 = 1 to require the TTY (login session only).
_operator_context_reason() {
  local text="$1" is_tty="$2" need_tty="$3" line
  line="${text%$'\n'}"
  if [[ "$line" == *$'\n'* ]]; then
    if [ "$need_tty" = 1 ]; then echo "not an operator login session"; else echo "not an operator login session or operator unit"; fi
    return 0
  fi
  if [[ "$line" =~ $_OPERATOR_TASK_RE ]]; then echo "running inside mission-control.service (a task)"; return 0; fi
  if [[ "$line" =~ $_OPERATOR_SESSION_RE ]]; then
    if [ "$need_tty" = 1 ] && [ "$is_tty" != 1 ]; then echo "operator terminal required"; fi
    return 0
  fi
  if [ "$need_tty" = 1 ]; then echo "not an operator login session"; return 0; fi
  if [[ "$line" =~ $_OPERATOR_UNIT_RE ]]; then return 0; fi
  echo "not an operator login session or operator unit"
}

# Exit 2 unless this is an operator context. `--tty` also requires a terminal.
require_operator_context() {
  local need_tty=0 is_tty=0 cgroup="" reason
  [ "${1:-}" = "--tty" ] && need_tty=1
  [ -t 0 ] && [ -t 1 ] && is_tty=1
  cgroup="$(cat /proc/self/cgroup 2>/dev/null || true)"
  reason="$(_operator_context_reason "$cgroup" "$is_tty" "$need_tty")"
  if [ -n "$reason" ]; then
    echo "[operator-gate] ${reason}; this command is not callable from a task" >&2
    exit 2
  fi
}

# Pure: exit 0 when `mc-ctl $1 $2` is in GATED_SUBCOMMANDS.
_mc_ctl_gated() {
  local cmd="${1:-}" sub="${2:-}" entry
  for entry in "${GATED_SUBCOMMANDS[@]}"; do
    if [ "$entry" = "$cmd" ] || [ "$entry" = "$cmd $sub" ]; then return 0; fi
  done
  return 1
}

# Pure: exit 0 when `$1` may run in `mc-ctl db`'s read-only branch (audit R2
# W5): its first token is SELECT, WITH or EXPLAIN. sqlite3 reads a dot-command
# (`.trace <file>`, `.shell`) only at the start of its argument, and PRAGMA /
# VACUUM / ATTACH never start with these words.
_db_readonly_sql_ok() {
  local re='^[[:space:]]*([Ss][Ee][Ll][Ee][Cc][Tt]|[Ww][Ii][Tt][Hh]|[Ee][Xx][Pp][Ll][Aa][Ii][Nn])([^[:alnum:]_]|$)'
  [[ "${1:-}" =~ $re ]]
}
