#!/bin/bash
# Ruling 5a option (b), Step 2 (Recipe C, variant SL) + Step 3 checks. OPERATOR-RUN, Panel terminal.
#
#   bash /root/claude/mission-control/docs/planning/5a-db-side/step2-apply-and-verify.sh
#
# Options:  --edit-only    install the files + edit docker-compose.yml, do NOT recreate the container
#           --check-only   skip install/edit/recreate, run only the Step 3 checks
#           --with-api-key also hit the DENUE analyzer's DB-backed GET (asks for its X-Api-Key at a hidden prompt)
#
# What it does: installs the two files to /opt/supabase/volumes/db/hba-5a, backs up
# docker-compose.yml to docker-compose.yml.bak-5a-20261019, inserts ONE volume line and
# THREE -c flags into the db service (exact-line anchors; refuses if an anchor is missing),
# validates the yaml with `docker compose config -q`, recreates ONLY supabase-db
# (`up -d --no-deps db`; 5-20 s on :5433), polls for healthy, then runs the Step 3 checks
# and prints PASS/FAIL per check. Idempotent: already-present lines are left alone.
# Rollback is printed at the end on failure (also in APPLY.md).
set -uo pipefail

SRC=/root/claude/mission-control/docs/planning/5a-db-side
COMPOSE=/opt/supabase/docker-compose.yml
BAK=/opt/supabase/docker-compose.yml.bak-5a-20261019
HBA_DIR=/opt/supabase/volumes/db/hba-5a
VOL_ANCHOR='      - ./volumes/db/init:/docker-entrypoint-initdb.d'
VOL_LINE='      - ./volumes/db/hba-5a:/etc/postgresql-5a:ro'
CMD_ANCHOR='      -c cron.database_name=${POSTGRES_DB}'
CMD_LINES='      -c hba_file=/etc/postgresql-5a/pg_hba.conf
      -c ident_file=/etc/postgresql-5a/pg_ident.conf
      -c cron.use_background_workers=on'

DO_EDIT=1; DO_UP=1; DO_CHECK=1; WITH_KEY=0
for a in "$@"; do
  case "$a" in
    --edit-only)   DO_UP=0; DO_CHECK=0 ;;
    --check-only)  DO_EDIT=0; DO_UP=0 ;;
    --with-api-key) WITH_KEY=1 ;;
    *) echo "usage: $0 [--edit-only|--check-only] [--with-api-key]"; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
fail=0
say() { printf '\n== %s\n' "$*"; }
ok()  { printf 'OK   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

# insert_after <file> <anchor-line> <text-to-insert> <marker-grep> : idempotent exact-line insert
insert_after() {
  local file=$1 anchor=$2 text=$3 marker=$4 n
  if grep -qF -- "$marker" "$file"; then ok "$file already has '$marker'"; return 0; fi
  n=$(grep -nxF -- "$anchor" "$file" | cut -d: -f1)
  if [ "$(printf '%s\n' "$n" | grep -c .)" != 1 ]; then bad "anchor not found exactly once in $file: $anchor"; return 1; fi
  awk -v n="$n" -v ins="$text" 'NR==n{print; print ins; next}{print}' "$file" > "$file.5a-tmp" \
    && cat "$file.5a-tmp" > "$file" && rm -f "$file.5a-tmp" || { bad "write failed for $file"; return 1; }
  grep -qF -- "$marker" "$file" && ok "inserted after line $n of $file: $marker" || { bad "insert verify $marker"; return 1; }
}

if [ "$DO_EDIT" = 1 ]; then
  say "2a. install the hba/ident files to $HBA_DIR"
  install -d -m 755 "$HBA_DIR" && ok "dir $HBA_DIR" || bad "install -d $HBA_DIR"
  install -m 644 "$SRC/pg_hba.conf.socket-and-loopback" "$HBA_DIR/pg_hba.conf" && ok "pg_hba.conf installed" || bad "install pg_hba.conf"
  install -m 644 "$SRC/pg_ident.conf.proposed" "$HBA_DIR/pg_ident.conf" && ok "pg_ident.conf installed" || bad "install pg_ident.conf"
  head -1 "$HBA_DIR/pg_hba.conf" | grep -q . && ok "pg_hba.conf non-empty ($(wc -l < "$HBA_DIR/pg_hba.conf") lines)" || bad "pg_hba.conf empty"
  grep -qxF 'local all mcp_readonly,longevidad_ro,denue_api,denue_sage trust' "$HBA_DIR/pg_hba.conf" \
    && ok "RO/DENUE trust line present" || bad "RO/DENUE trust line missing from installed pg_hba.conf"
  grep -qE '^m5a[[:space:]]+postgres[[:space:]]+supabase_admin' "$HBA_DIR/pg_ident.conf" && ok "m5a map present" || bad "m5a map missing"

  say "2b. edit $COMPOSE (db service)"
  if [ ! -e "$BAK" ]; then cp -p "$COMPOSE" "$BAK" && ok "backup $BAK"; else ok "backup already present: $BAK"; fi
  insert_after "$COMPOSE" "$VOL_ANCHOR" "$VOL_LINE" 'postgresql-5a:ro'
  insert_after "$COMPOSE" "$CMD_ANCHOR" "$CMD_LINES" 'use_background_workers=on'
  c=$(grep -cE 'postgresql-5a|use_background_workers' "$COMPOSE")
  [ "$c" = 4 ] && ok "4 new lines in $COMPOSE" || bad "expected 4 matching lines in $COMPOSE, got $c"
  ( cd /opt/supabase && docker compose config -q ) && ok "docker compose config -q" || bad "docker compose config rejects the edited file"
  if [ "$fail" = 1 ]; then
    echo; echo "STOP: fix the FAIL lines before recreating the container. Rollback: cp -p $BAK $COMPOSE"; exit 1
  fi
fi

if [ "$DO_UP" = 1 ]; then
  say "2c. recreate supabase-db only (5-20 s on :5433)"
  t0=$(date +%s)
  ( cd /opt/supabase && docker compose up -d --no-deps db ); rc=$?
  [ "$rc" = 0 ] && ok "docker compose up -d --no-deps db" || bad "docker compose up exit $rc"
  s=unknown
  for i in $(seq 1 90); do
    s=$(docker inspect --format '{{.State.Health.Status}}' supabase-db 2>/dev/null || echo missing)
    [ "$s" = healthy ] && break
    sleep 1
  done
  t1=$(date +%s)
  [ "$s" = healthy ] && ok "supabase-db healthy after $((t1 - t0))s" || bad "supabase-db is '$s' after $((t1 - t0))s"
  if [ "$s" != healthy ]; then
    echo; echo "STOP. Last 20 db log lines (masked to status words):"
    docker logs --tail 20 supabase-db 2>&1 | grep -oE 'FATAL|PANIC|ERROR|could not|invalid|database system is ready to accept connections|skipping' | sort | uniq -c
    echo "Rollback: cp -p $BAK $COMPOSE && cd /opt/supabase && docker compose up -d --no-deps db"; exit 1
  fi
fi

if [ "$DO_CHECK" = 1 ]; then
  say "3. post-apply checks (expected result after each)"
  # helper: run a docker exec psql probe, capture rc + first line, compare
  probe() { # <label> <expect: ok|refused> <expected-stdout-or-empty> -- <cmd...>
    local label=$1 expect=$2 want=$3; shift 4
    local out rc
    out=$("$@" 2>&1); rc=$?
    local first; first=$(printf '%s\n' "$out" | head -1)
    case "$expect" in
      ok)      if [ "$rc" = 0 ] && { [ -z "$want" ] || [ "$first" = "$want" ]; }; then ok "$label → '$first'"; else bad "$label → rc=$rc '$first' (expected ok${want:+ '$want'})"; fi ;;
      refused) if [ "$rc" != 0 ] && printf '%s' "$out" | grep -qiE 'authentication failed|no password supplied|password authentication failed'; then ok "$label → refused ($first)"; else bad "$label → rc=$rc '$first' (expected an authentication refusal)"; fi ;;
    esac
  }
  n=$(docker exec supabase-db cat /proc/1/cmdline | tr '\0' '\n' | grep -cE 'hba_file|ident_file|use_background_workers')
  [ "$n" = 3 ] && ok "1. postmaster carries the 3 flags" || bad "1. postmaster shows $n of the 3 flags (0 = still the old container)"
  probe "2. root socket -U postgres"        refused "" -- docker exec supabase-db psql -U postgres -c 'select 1'
  probe "3. root socket -U supabase_admin"  refused "" -- docker exec supabase-db psql -U supabase_admin -d postgres -c 'select 1'
  probe "4. -u postgres socket -U postgres" ok postgres -- docker exec -u postgres supabase-db psql -U postgres -At -c 'select current_user'
  probe "5. -u 65534 socket -U postgres"    refused "" -- docker exec -u 65534 supabase-db psql -U postgres -c 'select 1'
  probe "6. loopback -U postgres (SL)"      refused "" -- docker exec supabase-db psql -h 127.0.0.1 -U postgres -c 'select 1'
  probe "7. mcp_readonly socket"            ok mcp_readonly -- docker exec supabase-db psql -U mcp_readonly -d postgres -At -c 'select current_user'
  probe "8. denue_api socket (analyzer form)"  ok denue_api  -- docker exec -i supabase-db psql -X -q -t -A -U denue_api  -d postgres -c 'select current_user'
  probe "9. denue_sage socket"              ok denue_sage -- docker exec -i supabase-db psql -X -q -t -A -U denue_sage -d postgres -c 'select current_user'
  h=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3030/health); [ "$h" = 200 ] && ok "10. analyzer /health 200 (no DB)" || bad "10. analyzer /health → $h"
  if [ "$WITH_KEY" = 1 ]; then
    printf 'DENUE analyzer X-Api-Key (hidden): '; read -rs K; echo
    e=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $K" http://127.0.0.1:3030/entidades); unset K
    [ "$e" = 200 ] && ok "11. analyzer /entidades 200 (DB-backed, denue_api)" || bad "11. analyzer /entidades → $e (401 = wrong key, proves nothing about the DB)"
  else
    echo "--   11. analyzer /entidades skipped (re-run with --check-only --with-api-key to include it)"
  fi
  j=$(journalctl -u denue-analyzer --since '-10 min' --no-pager 2>/dev/null | grep -ciE 'authentication failed|no password supplied')
  [ "$j" = 0 ] && ok "12. denue-analyzer journal: 0 auth failures in 10 min" || bad "12. denue-analyzer journal: $j auth-failure lines"
  r=$(docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'supabase|kong' | grep -c Restarting)
  [ "$r" = 0 ] && ok "13. no supabase container Restarting" || bad "13. $r supabase container(s) Restarting"
  docker ps --format '   {{.Names}}\t{{.Status}}' | grep -E 'supabase|kong'
  a=$(systemctl is-active mission-control trustr-api agentic-crm denue-analyzer | grep -c '^active$')
  [ "$a" = 4 ] && ok "14. mission-control trustr-api agentic-crm denue-analyzer all active" || bad "14. only $a of 4 units active: $(systemctl is-active mission-control trustr-api agentic-crm denue-analyzer | tr '\n' ' ')"
  # the warning from APPLY.md, proven: a password does not open the socket for the superusers
  echo "--   note: root + password on the socket stays refused (peer line does not fall through); use -u postgres or -h 127.0.0.1 + password."
fi

say "summary"
if [ "$fail" = 0 ]; then
  echo "STEP 2+3 PASS. Next: bash $SRC/step1-host-consumers.sh --run-only  (backup + refresh under the new rules)."
else
  echo "FAIL lines above. Rollback (restores the old rules, keeps the installed files): cp -p $BAK $COMPOSE && cd /opt/supabase && docker compose up -d --no-deps db"
  exit 1
fi
