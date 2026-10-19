#!/bin/bash
# Queue 4w (ii), ruling (a) 2026-10-19: dedicated least-privilege role `minisu` for the two
# Jarvis-workspace scripts that 5a now refuses as `-U postgres`. OPERATOR-RUN, Panel terminal.
#
#   bash /root/claude/mission-control/docs/planning/5a-db-side/step3-minisu-role.sh
#
# Options:  --check-only   skip (i)-(iii) and (v), run only the (iv) checks
#
# What it does (each step idempotent; PASS/FAIL per line; exit 1 on any FAIL):
#  (i)   applies minisu-role.sql via the peer route (OS postgres -> supabase_admin)
#  (ii)  backs up the live pg_hba.conf to pg_hba.conf.pre-minisu, then installs the repo rev-4
#        pg_hba.conf.socket-and-loopback ONLY if the live file is byte-for-byte the rev-3 file
#        installed at 21:08 UTC (sha256 below, first trust line checked as an exact-line anchor);
#        refuses on any other content; afterwards `cmp` installed == repo rev 4
#  (iii) pg_ctl reload (re-reads pg_hba.conf; no restart, no downtime)
#  (iv)  checks: minisu over the socket as root; a granted SELECT; a non-granted SELECT is
#        `permission denied`; root -U postgres still refused; mcp_readonly still admitted
#  (v)   edits ONE line in each script (-U postgres -> -U minisu, exact-line anchors) after
#        backup copies in $SCRIPT_BAK (outside the hba-5a dir, which is bind-mounted into the
#        container); (vi) syntax checks (python compile(), bash -n); (vii) registry note + rollback
#
# The STEP3_* variables exist only so the same script could be proven on the throwaway
# container (PROOF in MINISU-ROLE.md); leave them unset on the live run.
set -uo pipefail

SRC=/root/claude/mission-control/docs/planning/5a-db-side
C=${STEP3_CONTAINER:-supabase-db}
HBA_DIR=${STEP3_HBA_DIR:-/opt/supabase/volumes/db/hba-5a}
WS=${STEP3_WS_DIR:-/root/claude/jarvis-kb/workspace}
SCRIPT_BAK=${STEP3_SCRIPT_BAK:-/opt/supabase/volumes/db/hba-5a-script-backups}
HBA="$HBA_DIR/pg_hba.conf"
HBA_BAK="$HBA_DIR/pg_hba.conf.pre-minisu"
REV4="$SRC/pg_hba.conf.socket-and-loopback"
REV3_SHA=00f94e894356457d20743717d0cb44dfb203f13313c6150e2315841e0b367f28
TRUST_OLD='local   all             mcp_readonly,longevidad_ro,denue_api,denue_sage      trust'
TRUST_NEW='local   all             mcp_readonly,longevidad_ro,denue_api,denue_sage,minisu  trust'
PY="$WS/minisu-batch-generator.py"
PY_OLD='        "-U", "postgres", "-d", "postgres",'
PY_NEW='        "-U", "minisu", "-d", "postgres",'
SH="$WS/minisu-loop.sh"
SH_OLD="cmd = ['docker','exec','supabase-db','psql','-U','postgres','-d','postgres','-t','-A','-c','SELECT COUNT(*) FROM minisu.productos;']"
SH_NEW="cmd = ['docker','exec','supabase-db','psql','-U','minisu','-d','postgres','-t','-A','-c','SELECT COUNT(*) FROM minisu.productos;']"

DO_APPLY=1
for a in "$@"; do
  case "$a" in
    --check-only) DO_APPLY=0 ;;
    *) echo "usage: $0 [--check-only]"; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
fail=0
say() { printf '\n== %s\n' "$*"; }
ok()  { printf 'OK   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

# replace_line <file> <old-line> <new-line> : idempotent exact-whole-line replace, same inode
replace_line() {
  local file=$1 old=$2 new=$3 n
  if [ "$(grep -cxF -- "$new" "$file")" = 1 ] && ! grep -qxF -- "$old" "$file"; then ok "$(basename "$file") already edited"; return 0; fi
  n=$(grep -nxF -- "$old" "$file" | cut -d: -f1)
  if [ "$(printf '%s\n' "$n" | grep -c .)" != 1 ]; then bad "anchor not found exactly once in $file"; return 1; fi
  awk -v n="$n" -v rep="$new" 'NR==n{print rep; next}{print}' "$file" > "$file.minisu-tmp" \
    && cat "$file.minisu-tmp" > "$file" && rm -f "$file.minisu-tmp" || { bad "write failed for $file"; return 1; }
  [ "$(grep -cxF -- "$new" "$file")" = 1 ] && ok "$(basename "$file") line $n: -U postgres -> -U minisu" || { bad "edit verify $file"; return 1; }
}

if [ "$DO_APPLY" = 1 ]; then
  say "(i) apply minisu-role.sql (peer route, supabase_admin)"
  docker exec -i -u postgres "$C" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < "$SRC/minisu-role.sql" \
    && ok "minisu-role.sql applied (exit 0)" || bad "minisu-role.sql failed (transaction rolled back)"
  r=$(docker exec -u postgres "$C" psql -X -U supabase_admin -d postgres -At -c \
    "select concat(rolcanlogin::int, rolsuper::int, rolinherit::int, rolcreatedb::int, rolcreaterole::int, rolbypassrls::int, rolreplication::int, (rolpassword is null)::int) from pg_authid where rolname='minisu'" 2>&1)
  [ "$r" = 10000001 ] && ok "role minisu: LOGIN, no SUPERUSER/INHERIT/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION, no password" || bad "role minisu attributes '$r' (want 10000001)"
  [ "$fail" = 1 ] && { echo; echo "STOP before touching pg_hba.conf."; exit 1; }

  say "(ii) pg_hba.conf rev 3 -> rev 4 (+ minisu on the trust line)"
  [ -s "$REV4" ] && grep -qxF -- "$TRUST_NEW" "$REV4" || { bad "repo $REV4 missing or lacks the rev-4 trust line"; exit 1; }
  if cmp -s "$HBA" "$REV4"; then
    ok "live pg_hba.conf already equals repo rev 4"
  elif [ "$(sha256sum < "$HBA" | cut -c1-64)" = "$REV3_SHA" ] && [ "$(grep -cxF -- "$TRUST_OLD" "$HBA")" = 1 ]; then
    if [ ! -e "$HBA_BAK" ]; then cp -p "$HBA" "$HBA_BAK" && ok "backup $HBA_BAK" || { bad "backup $HBA_BAK"; exit 1; }; else ok "backup already present: $HBA_BAK"; fi
    cat "$REV4" > "$HBA.minisu-tmp" && chmod 644 "$HBA.minisu-tmp" && mv -f "$HBA.minisu-tmp" "$HBA" \
      && ok "installed repo rev 4 over the rev-3 file" || bad "install rev 4 failed"
  else
    bad "live $HBA is neither the expected rev 3 (sha256 + trust-line anchor) nor repo rev 4: not touched"
    echo "     inspect: diff $HBA $REV4"; exit 1
  fi
  cmp -s "$HBA" "$REV4" && ok "cmp installed == repo rev 4" || bad "installed pg_hba.conf differs from repo rev 4"
  [ "$(grep -cxF -- "$TRUST_NEW" "$HBA")" = 1 ] && ok "rev-4 trust line present once" || bad "rev-4 trust line not present exactly once"

  say "(iii) reload (re-reads pg_hba.conf)"
  docker exec -u postgres "$C" pg_ctl reload -D /var/lib/postgresql/data >/dev/null && ok "pg_ctl reload" || bad "pg_ctl reload failed"
  sleep 1
  e=$(docker exec -u postgres "$C" psql -X -U supabase_admin -d postgres -At -c "select count(*) from pg_hba_file_rules where error is not null" 2>&1)
  [ "$e" = 0 ] && ok "pg_hba_file_rules: 0 parse errors" || bad "pg_hba_file_rules errors: '$e' (restore: cp -p $HBA_BAK $HBA and reload)"
fi

say "(iv) checks"
probe() { # <label> <expect: ok|refused|denied> <expected-first-line-or-empty> -- <cmd...>
  local label=$1 expect=$2 want=$3; shift 4
  local out rc first
  out=$("$@" 2>&1); rc=$?
  first=$(printf '%s\n' "$out" | head -1)
  case "$expect" in
    ok)      if [ "$rc" = 0 ] && { [ -z "$want" ] || [ "$first" = "$want" ]; }; then ok "$label -> '$first'"; else bad "$label -> rc=$rc '$first' (expected ok${want:+ '$want'})"; fi ;;
    refused) if [ "$rc" != 0 ] && printf '%s' "$out" | grep -qiE 'authentication failed|no password supplied'; then ok "$label -> refused"; else bad "$label -> rc=$rc '$first' (expected an authentication refusal)"; fi ;;
    denied)  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -qi 'permission denied'; then ok "$label -> permission denied"; else bad "$label -> rc=$rc '$first' (expected permission denied)"; fi ;;
  esac
}
probe "1. root socket -U minisu"                       ok minisu -- docker exec "$C" psql -X -w -U minisu -d postgres -At -c 'select current_user'
probe "2. minisu: count(*) minisu.productos (granted)" ok ""     -- docker exec "$C" psql -X -w -U minisu -d postgres -At -c 'select count(*) > 0 from minisu.productos'
probe "3. minisu: minisu.ventas (not granted)"         denied "" -- docker exec "$C" psql -X -w -U minisu -d postgres -At -c 'select count(*) from minisu.ventas'
probe "4. minisu: productos.costo (column not granted)" denied "" -- docker exec "$C" psql -X -w -U minisu -d postgres -At -c 'select count(costo) from minisu.productos'
probe "5. root socket -U postgres"                     refused "" -- docker exec "$C" psql -X -w -U postgres -d postgres -c 'select 1'
probe "6. root socket -U mcp_readonly"                 ok mcp_readonly -- docker exec "$C" psql -X -w -U mcp_readonly -d postgres -At -c 'select current_user'
probe "7. loopback -U minisu (no password over TCP)"   refused "" -- docker exec "$C" psql -X -w -h 127.0.0.1 -U minisu -d postgres -c 'select 1'

if [ "$DO_APPLY" = 1 ]; then
  if [ "$fail" = 1 ]; then echo; echo "STOP before editing the scripts (rollback below)."; fi
  if [ "$fail" = 0 ]; then
    say "(v) scripts: -U postgres -> -U minisu (backups in $SCRIPT_BAK)"
    install -d -m 700 "$SCRIPT_BAK" && ok "dir $SCRIPT_BAK (700)" || bad "install -d $SCRIPT_BAK"
    for f in "$PY" "$SH"; do
      b="$SCRIPT_BAK/$(basename "$f").pre-minisu"
      if [ ! -e "$b" ]; then cp -p "$f" "$b" && ok "backup $b" || { bad "backup $b"; continue; }; else ok "backup already present: $b"; fi
    done
    [ "$fail" = 0 ] && replace_line "$PY" "$PY_OLD" "$PY_NEW"
    [ "$fail" = 0 ] && replace_line "$SH" "$SH_OLD" "$SH_NEW"
    n=$(grep -cE "(\"-U\", \"postgres\"|'-U','postgres')" "$PY" "$SH" | awk -F: '{s+=$2} END{print s+0}')
    [ "$n" = 0 ] && ok "no '-U postgres' left in the two scripts" || bad "$n '-U postgres' occurrence(s) left"

    say "(vi) syntax"
    # = python3 -m py_compile without writing a __pycache__/ .pyc into the KB workspace
    python3 -I -c 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")' "$PY" \
      && ok "compile() syntax check $(basename "$PY")" || bad "compile() syntax check $(basename "$PY")"
    bash -n "$SH" && ok "bash -n $(basename "$SH")" || bad "bash -n $(basename "$SH")"
  fi
fi

say "(vii) notes"
echo "Registry: nothing to do. jarvis_files / the hourly kb-reindex walk / Drive sync carry only .md files"
echo "  (walkKbDir in src/db/jarvis-reindex.ts); the two scripts are not in the registry, and Jarvis runs them"
echo "  from disk through shell_exec (/bin/sh -c on the host), so the edit is live on the next run."
echo "Rollback (in this order):"
echo "  cp -p $SCRIPT_BAK/minisu-batch-generator.py.pre-minisu $PY"
echo "  cp -p $SCRIPT_BAK/minisu-loop.sh.pre-minisu $SH"
echo "  cp -p $HBA_BAK $HBA && docker exec -u postgres $C pg_ctl reload -D /var/lib/postgresql/data"
echo "  docker exec -i -u postgres $C psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - <<'SQL'"
echo "  REVOKE ALL ON ALL TABLES IN SCHEMA minisu FROM minisu; REVOKE USAGE ON SCHEMA minisu FROM minisu; DROP ROLE minisu;"
echo "  SQL"

say "summary"
if [ "$fail" = 0 ]; then
  echo "STEP 3 (minisu) PASS."
else
  echo "FAIL lines above. See the rollback lines."
  exit 1
fi
