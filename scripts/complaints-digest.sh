#!/usr/bin/env bash
# Complaints digest over the task database, strictly read-only.
#
#   bash scripts/complaints-digest.sh [--db <path>] [--days N] [--last N] [--min K]
#                                     [--type <key>] [--json] [--now <ISO time>]
#
# The CLI (scripts/complaints-digest.ts) prints the SQL; sqlite3 runs it with
# -readonly fixed here (not a parameter), so no code path can open the
# database for writing; the rows go back into the CLI on stdin.
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
sqlite3 -readonly -bail -json "$DB" <<<"$sql" | "$TSX" "$CLI" "${args[@]}"
