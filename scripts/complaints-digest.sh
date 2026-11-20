#!/usr/bin/env bash
# Complaints digest over the task database, strictly read-only.
#
#   bash scripts/complaints-digest.sh [--db <path>] [--days N] [--last N] [--min K]
#                                     [--type <key>] [--json] [--now <ISO time>]
#
# The CLI (scripts/complaints-digest.ts) prints the SQL; sqlite3 runs it with
# -readonly fixed here (not a parameter), so no code path can open the
# database for writing; the rows go back into the CLI on stdin.
# -init /dev/null: sqlite3 would otherwise run ~/.sqliterc or
# $XDG_CONFIG_HOME/sqlite3/sqliterc first, and an rc file can .open the
# database read-write. sqlite3 is called by absolute path so PATH cannot swap it.
# --now defaults to the current time, pinned once so both CLI calls agree.
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
sql="$("$TSX" "$CLI" --print-sql "${args[@]}")"
errf="$(mktemp)"
trap 'rm -f "$errf"' EXIT
if ! rows="$(/usr/bin/sqlite3 -init /dev/null -safe -readonly -bail -json -- "$DB" <<<"$sql" 2>"$errf")"; then
  # Some errors (e.g. "file is not a database") go to stdout; never echo the
  # captured rows, which could hold task text after a mid-stream failure.
  reason="$(head -n 1 "$errf")"
  echo "complaints-digest: sqlite3 failed on $DB: ${reason:-(no message on stderr)}" >&2
  exit 1
fi
printf '%s' "$rows" | "$TSX" "$CLI" "${args[@]}"
