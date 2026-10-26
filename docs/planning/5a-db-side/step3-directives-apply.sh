#!/bin/bash
# Queue 4x step 3 (2026-10-20): move the three DENUE directive rows off `psql -U postgres` and
# `-c "…"` (both refused by the ruling-5a shell gate since 10-18). OPERATOR-RUN, Panel terminal,
# from a subshell that has exported the mission-control service env (the pgvector + Drive copies
# of a row refresh only when COMMIT_DB_KEY / DRIVE_KB_FOLDER_ID are present):
#
#   cd /root/claude/mission-control && ( set -a; . ./<service env file>; set +a; bash docs/planning/5a-db-side/step3-directives-apply.sh )
#
# Options:  --dry-run   steps (i)-(iii) and the rewrite dry run only; nothing written anywhere
#
# What it does (idempotent; stops on the first failure; nothing is written on a dry run):
#  (i)   hand-edit of the mirror file directives/data-doc-authoring.md lines 24-25: the fenced
#        two-line psql command that REDIRECTS its output to a file (`> <ruta>` on the continuation
#        line — the gate refuses any redirect, -o and \copy too) becomes one line with `--csv`, and a
#        sentence after the fence says the CSV is saved with file_write. Skipped when already done.
#  (ii)  kb-import-from-disk: that mirror file into its EXISTING jarvis_files row (metadata kept,
#        user-edit bump) — dry run printed, then --apply. The hourly walk never refreshes directives/.
#  (iii) kb-rewrite-denue-psql dry run: all three rows must print PASS (role + quote swaps, gate-checked)
#  (iv)  kb-rewrite-denue-psql --apply (row + mirror, verified by the script)
#  (v)   count of the three rows now on `psql -U mcp_readonly` and free of `-c "`: must be 3
# Then the proof by use: one DENUE density question to Jarvis; the journal must show
# `shell-guard] OK: … -U mcp_readonly` and no BLOCKED line for it.
set -euo pipefail
cd /root/claude/mission-control
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
KB=/root/claude/jarvis-kb
F="$KB/directives/data-doc-authoring.md"
DB=/root/claude/mission-control/data/mc.db

ok()   { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n== (%s) %s\n' "$1" "$2"; }

step pre "service env present (names only)"
for v in COMMIT_DB_KEY DRIVE_KB_FOLDER_ID; do
  [[ -n "${!v:-}" ]] || fail "$v is not exported — run this script from the env-sourcing subshell in the header"
done
ok "COMMIT_DB_KEY DRIVE_KB_FOLDER_ID exported"
[[ -f "$F" ]] || fail "mirror file missing: $F"
[[ -L "$F" ]] && fail "mirror file is a symlink: $F"

step i "hand-edit lines 24-25 of directives/data-doc-authoring.md (output redirect -> --csv + file_write)"
python3 - "$F" "$DRY" <<'PY'
import sys
p, dry = sys.argv[1], sys.argv[2] == "1"
L = open(p, encoding="utf-8").read().split("\n")
l24, l25, l26 = L[23], L[24], L[25]
if "--csv" in l24 and not l24.endswith("\\") and l25.startswith("```"):
    print("PASS already edited (one-line --csv command, fence follows)"); sys.exit(0)
if not (L[22].startswith("```") and l26.startswith("```")):
    print("FAIL fence anchors moved (expected fences on lines 23 and 26): edit by hand"); sys.exit(1)
if not (l24.startswith("docker exec") and "psql" in l24 and l24.endswith("\\")):
    print("FAIL line 24 is not the backslash-continued docker exec psql command"); sys.exit(1)
if not l25.lstrip().startswith(">"):
    print("FAIL line 25 is not the output redirect"); sys.exit(1)
if " -c " not in l24:
    print("FAIL line 24 has no -c flag to anchor --csv on"); sys.exit(1)
new24 = l24[:-1].rstrip().replace(" -c ", " --csv -c ", 1)
prose = "Guarda la salida CSV del tool en `<ruta>` con `file_write`: el gate no permite redirigir con `>` ni usar `-o`."
L[23:25] = [new24]           # line 24 rewritten, line 25 (the redirect) dropped
L[25:25] = [prose, ""]       # after the closing fence: the sentence, then a blank line
print(f"PASS line 24: {len(l24)} -> {len(new24)} chars, redirect line dropped, 1 sentence added after the fence")
if dry:
    print("PASS dry run — file not written"); sys.exit(0)
open(p, "w", encoding="utf-8").write("\n".join(L))
print(f"PASS written: {len(L)} lines")
PY

step ii "import the mirror file into its registry row"
npx tsx scripts/kb-import-from-disk.ts --path directives/data-doc-authoring.md 2> >(grep -v '^\[tuning\]' >&2)
if (( DRY )); then ok "dry run — import not applied"; else
  npx tsx scripts/kb-import-from-disk.ts --path directives/data-doc-authoring.md --apply 2> >(grep -v '^\[tuning\]' >&2)
fi

step iii "rewrite dry run: all three rows must PASS"
OUT=$(npx tsx scripts/kb-rewrite-denue-psql.ts 2> >(grep -v '^\[tuning\]' >&2)) || true   # exit 1 = a refused row; judged below
printf '%s\n' "$OUT"
if (( DRY )); then
  if grep -q '^FAIL' <<<"$OUT"; then ok "a FAIL line here is expected on a dry run: the import was not applied, so data-doc-authoring still carries the redirect"; else ok "rewrite dry run clean"; fi
  printf '\n%s\n' "DRY RUN done — nothing written. Re-run without --dry-run."; exit 0
fi
grep -q '^FAIL' <<<"$OUT" && fail "the rewrite still refuses a row — see the FAIL line above; nothing applied"
ok "no FAIL line"

step iv "rewrite --apply"
npx tsx scripts/kb-rewrite-denue-psql.ts --apply 2> >(grep -v '^\[tuning\]' >&2)

step v "verify the three rows"
N=$(sqlite3 -readonly "$DB" "select count(*) from jarvis_files where path in ('directives/denue-access-card.md','directives/denue-analyzer-granularities.md','directives/data-doc-authoring.md') and content like '%psql -U mcp_readonly%' and content not like '%-c \"%' and content not like '%psql -U postgres%';")
[[ "$N" == "3" ]] || fail "expected 3 clean rows, got $N"
ok "3/3 rows on psql -U mcp_readonly, no double-quoted -c span, no -U postgres"
M=$(grep -c -- '-U postgres' "$KB/directives/denue-access-card.md" "$KB/directives/denue-analyzer-granularities.md" "$F" | awk -F: '{s+=$2} END{print s+0}')
[[ "$M" == "0" ]] || fail "mirror files still carry $M '-U postgres' line(s)"
ok "mirror files clean"
printf '\n%s\n' "DONE. Proof by use: ask Jarvis one DENUE density question, then paste: journalctl -u mission-control --since '10 min ago' -o cat | grep -E 'shell-guard\] (OK|BLOCKED)' | grep -c mcp_readonly"
