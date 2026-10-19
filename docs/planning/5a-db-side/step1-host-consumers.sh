#!/bin/bash
# Ruling 5a option (b), Step 1: host consumers (OPERATOR-RUN, from the Panel terminal).
#
# Edits the two scheduled jobs that reach supabase-db over the container socket as a
# superuser, so that they use the peer route (`docker exec -u postgres`) the DB-side
# change keeps open, then runs each once by hand and checks the result. The fixed
# form also works TODAY (the in-use socket rule is `trust`), so this is safe to run
# before the apply; run it again after the apply (Step 3 of APPLY.md).
#
#   bash /root/claude/mission-control/docs/planning/5a-db-side/step1-host-consumers.sh
#
# Options:  --edit-only   edit + commit, skip the two manual runs
#           --run-only    skip the edits, only run + check
# Idempotent: an already-edited line is left alone. Nothing here touches the db
# container's files or the compose project. Backup copy of backup.sh:
# /opt/supabase/backup.sh.bak-5a-20261019. The refresh script lives in the
# denue-data-analysis git repo; git holds its previous version.
set -uo pipefail

BACKUP_SH=/opt/supabase/backup.sh
BACKUP_OLD='docker exec supabase-db pg_dump -U supabase_admin -d postgres --no-owner --no-acl | gzip > "$BACKUP_DIR/commit_ai_${TIMESTAMP}.sql.gz"'
BACKUP_NEW='docker exec -u postgres supabase-db pg_dump -U supabase_admin -d postgres --no-owner --no-acl | gzip > "$BACKUP_DIR/commit_ai_${TIMESTAMP}.sql.gz"'
BACKUP_LINE=6
BACKUP_LOG=/var/log/supabase-backup.log
BACKUP_DIR=/opt/supabase/backups

DENUE_REPO=/root/claude/projects/data-intelligence/denue-data-analysis
REFRESH_SH=$DENUE_REPO/scripts/refresh-matviews.sh
REFRESH_OLD='docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'"'"'SQL'"'"
REFRESH_NEW='docker exec -i -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'"'"'SQL'"'"
REFRESH_LINE=57
REFRESH_UNIT=denue-matview-refresh.service

DO_EDIT=1; DO_RUN=1
case "${1:-}" in
  --edit-only) DO_RUN=0 ;;
  --run-only)  DO_EDIT=0 ;;
  "") ;;
  *) echo "usage: $0 [--edit-only|--run-only]"; exit 2 ;;
esac

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
fail=0
say() { printf '\n== %s\n' "$*"; }
ok()  { printf 'OK   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

# ---------------------------------------------------------------- edit one line
# edit_line <file> <lineno> <old> <new> ; returns 0 when the file ends in the new state
edit_line() {
  local file=$1 n=$2 old=$3 new=$4 cur
  cur=$(sed -n "${n}p" "$file")
  if [ "$cur" = "$new" ]; then ok "$file:$n already edited"; return 0; fi
  if [ "$cur" != "$old" ]; then
    bad "$file:$n is not the expected line; not touching it. Current line:"
    printf '     %s\n' "$cur"
    return 1
  fi
  # replace exactly line n with the new text (no regex: write via awk with a literal)
  awk -v n="$n" -v repl="$new" 'NR==n{print repl; next}{print}' "$file" > "$file.5a-tmp" \
    && cat "$file.5a-tmp" > "$file" && rm -f "$file.5a-tmp" || { bad "write failed for $file"; return 1; }
  cur=$(sed -n "${n}p" "$file")
  [ "$cur" = "$new" ] && ok "$file:$n edited" || { bad "$file:$n verify after edit"; return 1; }
}

if [ "$DO_EDIT" = 1 ]; then
  say "1a. $BACKUP_SH line $BACKUP_LINE"
  if [ ! -e "$BACKUP_SH.bak-5a-20261019" ]; then
    cp -p "$BACKUP_SH" "$BACKUP_SH.bak-5a-20261019" && ok "backup copy $BACKUP_SH.bak-5a-20261019"
  else
    ok "backup copy already present"
  fi
  edit_line "$BACKUP_SH" "$BACKUP_LINE" "$BACKUP_OLD" "$BACKUP_NEW"
  bash -n "$BACKUP_SH" && ok "bash -n $BACKUP_SH" || bad "bash -n $BACKUP_SH"

  say "1b. $REFRESH_SH line $REFRESH_LINE"
  if [ -n "$(git -C "$DENUE_REPO" status --short -- scripts/refresh-matviews.sh)" ]; then
    echo "     note: the file already had uncommitted changes before this run"
  fi
  edit_line "$REFRESH_SH" "$REFRESH_LINE" "$REFRESH_OLD" "$REFRESH_NEW"
  bash -n "$REFRESH_SH" && ok "bash -n $REFRESH_SH" || bad "bash -n $REFRESH_SH"
  if [ -n "$(git -C "$DENUE_REPO" status --short -- scripts/refresh-matviews.sh)" ]; then
    git -C "$DENUE_REPO" add scripts/refresh-matviews.sh \
      && git -C "$DENUE_REPO" commit -q -m "ops: refresh-matviews runs psql as OS user postgres (ruling 5a DB-side peer route)" \
         -m "The supabase-db socket moves from trust to a peer map for OS user postgres; the timer's psql call gains -u postgres so it keeps working before and after the change." \
         -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01DB2KcG631GmbCj9gRykduo" \
      && ok "committed in $DENUE_REPO: $(git -C "$DENUE_REPO" log --oneline -1)" \
      || bad "git commit in $DENUE_REPO"
  else
    ok "nothing to commit in $DENUE_REPO"
  fi
fi

if [ "$DO_RUN" = 1 ]; then
  say "1a run. $BACKUP_SH (about 6 min; last two dumps were ~2.18 GB)"
  prev=$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1)
  prev_size=$([ -n "$prev" ] && stat -c %s "$prev" || echo 0)
  t0=$(date +%s)
  "$BACKUP_SH" >> "$BACKUP_LOG" 2>&1; rc=$?
  t1=$(date +%s)
  newest=$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1)
  new_size=$([ -n "$newest" ] && stat -c %s "$newest" || echo 0)
  echo "     exit=$rc  took=$((t1 - t0))s  newest=$newest  size=$new_size  previous=$prev_size"
  echo "     log: $(tail -1 "$BACKUP_LOG")"
  [ "$rc" = 0 ] && ok "backup.sh exit 0" || bad "backup.sh exit $rc"
  [ "$newest" != "$prev" ] && ok "a new dump exists" || bad "no new dump file"
  [ "$new_size" -gt 1048576 ] && ok "new dump > 1 MB" || bad "new dump is $new_size bytes"
  if [ "$prev_size" -gt 0 ]; then
    [ $((new_size * 10)) -gt $((prev_size * 9)) ] && ok "new dump within 10 % of the previous one" \
      || bad "new dump is far smaller than the previous one"
  fi
  tail -1 "$BACKUP_LOG" | grep -q '^\[.*\] Backup: commit_ai_' && ok "success line in $BACKUP_LOG" || bad "no success line in $BACKUP_LOG"

  say "1b run. systemctl start $REFRESH_UNIT (about 1.5 min; takes the MV locks, so outside working hours)"
  t0=$(date +%s)
  systemctl start "$REFRESH_UNIT"; rc=$?
  t1=$(date +%s)
  echo "     start exit=$rc  took=$((t1 - t0))s"
  systemctl show -p Result,ExecMainStatus "$REFRESH_UNIT"
  [ "$(systemctl show -p Result --value "$REFRESH_UNIT")" = success ] && ok "Result=success" || bad "Result is not success"
  [ "$(systemctl show -p ExecMainStatus --value "$REFRESH_UNIT")" = 0 ] && ok "ExecMainStatus=0" || bad "ExecMainStatus not 0"
  systemctl list-timers denue-matview-refresh.timer --no-pager | sed -n '1,2p'
fi

say "summary"
if [ "$fail" = 0 ]; then
  echo "STEP 1 PASS. Next: APPLY.md Step 2 (Recipe C), then Step 3, then run this script again with --run-only."
else
  echo "STEP 1 FAIL: fix the FAIL lines above before the apply. Rollback of backup.sh: cp -p $BACKUP_SH.bak-5a-20261019 $BACKUP_SH ; of the refresh script: git -C $DENUE_REPO checkout HEAD~1 -- scripts/refresh-matviews.sh (if this run committed it)."
  exit 1
fi
