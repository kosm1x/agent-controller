#!/usr/bin/env bash
# Complaints digest over the task database, strictly read-only.
#
#   bash scripts/complaints-digest.sh [--db <path>] [--days N] [--last N] [--min K]
#                                     [--type <key>] [--json] [--now <ISO time>]
#
# With task_completion_facts (schema 18 on), each type also gets a builds line:
# the runs of the last-N strip grouped by build in order of first appearance,
# each with its run, concern (C) and failed (F) counts as the strip classes them.
#
# The CLI (scripts/complaints-digest.ts) prints the SQL; sqlite3 runs it with
# -readonly fixed here (not a parameter), so no code path can open the
# database for writing; the rows go back into the CLI on stdin.
# -init /dev/null: sqlite3 would otherwise run ~/.sqliterc or
# $XDG_CONFIG_HOME/sqlite3/sqliterc first, and an rc file can .open the
# database read-write. sqlite3 is called by absolute path so PATH cannot swap it.
# --now defaults to the current time, pinned once so every CLI call agrees.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$ROOT/data/mc.db"
args=()
have_now=0
while (($#)); do
  case "$1" in
    --db) DB="${2:?--db needs a path}"; shift 2 ;;
    --db=*) DB="${1#--db=}"; shift ;;
    --now|--now=*) have_now=1; args+=("$1"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
((have_now)) || args+=(--now "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
[[ -f "$DB" ]] || { echo "complaints-digest: no database at $DB" >&2; exit 2; }

TSX="$ROOT/node_modules/.bin/tsx"
CLI="$ROOT/scripts/complaints-digest.ts"
# Flags are checked here (exit 2) before any sqlite3 call; this prints the SQL
# for a database without task_completion_facts.
sql="$("$TSX" "$CLI" --print-sql "${args[@]}")"
errf="$(mktemp)"
trap 'rm -f "$errf"' EXIT
# The one way this script runs sqlite3: SQL on stdin, and exactly one of two
# output modes named by a literal checked here; no other option reaches it.
sqlite_ro() {
  local mode
  case "$*" in
    list) mode=-list ;;
    json) mode=-json ;;
    *) echo "complaints-digest: sqlite_ro takes list or json, got: $*" >&2; return 1 ;;
  esac
  /usr/bin/sqlite3 -init /dev/null -safe -readonly -bail "$mode" -- "$DB" 2>"$errf" && return
  # The caller never echoes captured output, which could hold task text after
  # a mid-stream failure. The first call (a plain SELECT) reports an unreadable
  # database on stderr, so the reason is there.
  echo "complaints-digest: sqlite3 failed on $DB: $(head -n 1 "$errf")" >&2
  return 1
}
# Databases before schema 18 have no task_completion_facts: ask, and on a
# newer database print the SQL that reads it.
facts="$(sqlite_ro list <<<"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_completion_facts';")" || exit 1
if [[ $facts == 1 ]]; then sql="$("$TSX" "$CLI" --print-sql --facts-table "${args[@]}")"; fi
rows="$(sqlite_ro json <<<"$sql")" || exit 1
printf '%s' "$rows" | "$TSX" "$CLI" "${args[@]}"
