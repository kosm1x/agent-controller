#!/bin/bash
# Queue 4w (ii): operator wrapper around step3-minisu-role.sh for the Panel terminal.
#
#   bash /root/claude/mission-control/docs/planning/5a-db-side/step3-minisu-run.sh
#
# Runs, in order: (0) refuse while a minisu loop/generator process is alive (step 3 edits
# minisu-loop.sh in place, same inode, which corrupts a bash script that is executing);
# (1) report whether minisu-loop.sh:3 still exports a Google-API-key-shaped literal
# (value never printed) and ask before going on; (2) step3-minisu-role.sh --check-only
# (exit 1 is the expected answer BEFORE the apply: the role does not exist yet);
# (3) ask, then the full step3-minisu-role.sh; (4) read-back checks. Everything is
# copied to a log file under /root for pasting into the session.
set -uo pipefail

S=/root/claude/mission-control/docs/planning/5a-db-side/step3-minisu-role.sh
WS=/root/claude/jarvis-kb/workspace
HBA=/opt/supabase/volumes/db/hba-5a/pg_hba.conf
BAK=/opt/supabase/volumes/db/hba-5a-script-backups
LOG=/root/minisu-step3-$(date -u +%Y%m%dT%H%M%SZ).log

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
[ -t 0 ] || { echo "needs a terminal (Panel terminal), not a Claude Code '!' line"; exit 2; }
[ -x "$S" ] || [ -r "$S" ] || { echo "missing $S"; exit 2; }
exec > >(tee -a "$LOG") 2>&1
echo "step3-minisu-run $(date -u +%FT%TZ)  log: $LOG"

echo; echo "== 0. running-loop guard"
n=$(pgrep -c -f '^(/bin/)?(ba)?sh +\S*minisu-loop\.sh')
m=$(pgrep -c -f '^python3? +\S*minisu-batch-generator\.py')
if [ "$n" != 0 ] || [ "$m" != 0 ]; then
  echo "FAIL minisu-loop.sh procs=$n generator procs=$m. Stop them first; step 3 rewrites the loop script in place."
  exit 1
fi
echo "OK   no minisu loop or generator running"

echo; echo "== 1. key-shaped literal on $WS/minisu-loop.sh:3 (value never printed)"
if sed -n 3p "$WS/minisu-loop.sh" | grep -qE 'AIza[0-9A-Za-z_-]{30,}'; then
  echo "WARN line 3 still exports a Google-API-key-shaped literal. Step 3 does not touch that line."
  echo "     If the key is live: rotate it in AI Studio and move it to an env file before Jarvis runs the loop again."
  read -rp "     Continue with step 3 anyway? [y/N] " a; [ "$a" = y ] || { echo "stopped at the literal review"; exit 1; }
else
  echo "OK   line 3 holds no key-shaped literal"
fi

echo; echo "== 2. check-only"
bash "$S" --check-only; rc=$?
echo "check-only exit $rc (1 is expected before the apply: role minisu does not exist yet)"
read -rp "Apply step 3 now (role + pg_hba rev 4 + reload + script edits)? [y/N] " a
[ "$a" = y ] || { echo "stopped before apply"; exit 0; }

echo; echo "== 3. apply"
bash "$S"; rc=$?
echo "apply exit $rc"

echo; echo "== 4. read-back"
echo "roles named minisu: $(docker exec supabase-db psql -U mcp_readonly -d postgres -At -c "select count(*) from pg_roles where rolname='minisu'")"
echo "rev-4 trust lines in live pg_hba: $(grep -cE '^local +all +mcp_readonly,longevidad_ro,denue_api,denue_sage,minisu +trust' "$HBA")"
echo "script lines on -U minisu: loop=$(grep -c "'-U','minisu'" "$WS/minisu-loop.sh") generator=$(grep -c '"-U", "minisu"' "$WS/minisu-batch-generator.py")"
echo "backups:"; ls -la "$BAK" 2>/dev/null || echo "  (none at $BAK)"
echo "containers:"; docker ps --format '{{.Names}} {{.Status}}' | grep -E 'supabase-db|Restarting' || echo "  supabase-db not listed"
echo; echo "done. Paste the terminal output (or: cat $LOG) into the session."
exit "$rc"
