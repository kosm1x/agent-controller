#!/usr/bin/env bash
# scripts/predeploy-rulings-1-5.sh — READ-ONLY pre-deploy check for "rulings 1–5"
# (83b3cf3, PR #57). Operator-run from a plain terminal. It reads; it never
# deploys, builds, installs, restarts, fetches or writes to mc.db.
#
# Usage:
#   bash scripts/predeploy-rulings-1-5.sh
#   MC_DIR=/other/checkout bash scripts/predeploy-rulings-1-5.sh
#   KB_QUERIES="cliente|factura|deploy" bash scripts/predeploy-rulings-1-5.sh   # max 5 queries
#   SKIP_SHELL_DIFF=1 bash scripts/predeploy-rulings-1-5.sh                     # skip section E
#   EVAL_GATE_VERDICT=PASS bash scripts/predeploy-rulings-1-5.sh                # PASS or FAIL only:
#       the operator states the verdict of the paid gate run on this HEAD; the
#       script does not detect or verify it. Unset → printed as owed (a note);
#       FAIL → NOT READY; PASS → "stated by operator, not verified by this script".
#
# Sections:
#   A. Preconditions — branch is main, HEAD == origin/main AS LAST FETCHED (no
#      fetch), HEAD contains 83b3cf3, uncommitted build inputs (src/,
#      package.json, package-lock.json, tsconfig.json — tracked changes AND
#      untracked files, which a build would compile) and, apart, other dirty
#      tracked files (informational; not build inputs),
#      `systemctl is-active mission-control`, and which commit the live dist/
#      was built from (scripts/deploy.sh does not record it: "unknown", plus
#      dist/index.js build time vs the HEAD commit time).
#   B. Credential census (ruling 3d) — every user_facts row and every
#      projects.credentials leaf (nested included) with the NEW code's verdict:
#      HIDDEN (kept from the model, used by name; its SECRET_… reference name)
#      or CLEAR. Totals, reference-name collisions, and a by-shape boolean
#      (hidden because of the value's shape, not its name). Key names only.
#   C. KB search cost — the searchFiles path (FTS_FETCH_CAP = 5000) timed per
#      query in KB_QUERIES: rows fetched, rows returned, ms (median of 3);
#      over 500 ms is flagged. Counts and ms only.
#   D. Tool-less schedules — scheduled_tasks with tools='[]' AND active=1
#      (count, id, name, delivery); matters only under
#      INFERENCE_PRIMARY_PROVIDER=openai. A query error there is NOT READY.
#   E. Shell-gate differential (ruling 5e) — scripts/validate-shell-gate-diff.ts
#      --run --ref b5f8268 (the live build). Its full output can quote logged
#      shell commands (its redaction has known gaps), so it goes to a root-only
#      file (mode 600) under data/predeploy/ (dir 700, gitignored); only its
#      exit code, the per-group counts and the file path are printed.
#   F. Owed items this script cannot check (checklist).
#   G. Verdict.
#
# B–D run scripts/predeploy-rulings-1-5.ts (node_modules/.bin/tsx — nothing is
# downloaded; section E uses the same binary), which opens mc.db with
# better-sqlite3 { readonly, fileMustExist } + query_only and prints no stored
# value (no value, prefix, suffix, hash or length). No .env file is read.
#
# Exit codes:
#   0  READY or READY WITH NOTES (notes printed with the verdict)
#   1  NOT READY — wrong branch/commit, a census / KB-timing / tool-less
#      schedule step errored, a reference-name collision, the shell
#      differential exited 1 (unexplained differences) or 3 (error) or did not
#      complete (no per-group counts in its output), or EVAL_GATE_VERDICT=FAIL
#   2  the check itself failed (bad MC_DIR / KB_QUERIES / EVAL_GATE_VERDICT,
#      tsx missing, mc.db not openable read-only, helper crashed, data/ not
#      gitignored)
# The verdict covers A–E and the eval-gate item of F (via EVAL_GATE_VERDICT);
# the other F items are owed regardless and are listed apart.

set -u

MC_DIR="${MC_DIR:-/root/claude/mission-control}"
KB_QUERIES="${KB_QUERIES:-cliente|factura|deploy}"
RULINGS_COMMIT="83b3cf3"
LIVE_REF="b5f8268"
MAX_QUERIES=5

NOT_READY=()
NOTES=()
CHECK_FAILED=()

die() {
  echo "CHECK FAILED: $*" >&2
  echo "VERDICT: CHECK FAILED (exit 2)"
  exit 2
}

# ---------------------------------------------------------------- inputs
MC_DIR=$(cd "$MC_DIR" 2>/dev/null && pwd -P) || die "MC_DIR=${MC_DIR} cannot be resolved to a directory"
git -C "$MC_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "MC_DIR=$MC_DIR is not a git checkout"
DB="$MC_DIR/data/mc.db"
HELPER="$MC_DIR/scripts/predeploy-rulings-1-5.ts"
DIFF_SCRIPT="$MC_DIR/scripts/validate-shell-gate-diff.ts"
[[ -f "$DB" ]] || die "$DB not found"
[[ -f "$HELPER" ]] || die "$HELPER not found (is this checkout at 83b3cf3 or later with the helper?)"
TSX="$MC_DIR/node_modules/.bin/tsx"
[[ -x "$TSX" ]] || die "$TSX not found — the check uses the checkout's own tsx and downloads nothing"
EVAL_GATE_VERDICT="${EVAL_GATE_VERDICT:-}"
case "$EVAL_GATE_VERDICT" in
  "" | PASS | FAIL) ;;
  *) die "EVAL_GATE_VERDICT must be PASS or FAIL (got '$EVAL_GATE_VERDICT')" ;;
esac

nq=0
IFS='|' read -r -a _qs <<<"$KB_QUERIES"
for q in "${_qs[@]}"; do
  q="${q#"${q%%[![:space:]]*}"}"
  [[ -n "$q" ]] && nq=$((nq + 1))
done
((nq >= 1)) || die "KB_QUERIES has no query"
((nq <= MAX_QUERIES)) || die "KB_QUERIES has $nq queries; maximum $MAX_QUERIES — refusing"

echo "Pre-deploy check — rulings 1–5 ($RULINGS_COMMIT) — read-only — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Checkout: $MC_DIR"
echo

# ---------------------------------------------------------------- A
echo "A. Preconditions"
branch=$(git -C "$MC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
head=$(git -C "$MC_DIR" rev-parse HEAD 2>/dev/null || echo "?")
origin=$(git -C "$MC_DIR" rev-parse --verify --quiet origin/main 2>/dev/null || echo "?")
echo "  branch: $branch"
echo "  HEAD: ${head:0:12}   origin/main (as last fetched, not fetched now): ${origin:0:12}"
[[ "$branch" == "main" ]] || NOT_READY+=("branch is '$branch', not main")
if [[ "$head" != "$origin" ]]; then
  NOT_READY+=("HEAD ${head:0:12} != origin/main ${origin:0:12} (as last fetched)")
fi
if git -C "$MC_DIR" merge-base --is-ancestor "$RULINGS_COMMIT" HEAD 2>/dev/null; then
  echo "  HEAD contains $RULINGS_COMMIT: yes"
else
  echo "  HEAD contains $RULINGS_COMMIT: NO"
  NOT_READY+=("HEAD does not contain $RULINGS_COMMIT")
fi
BUILD_PATHS=(src/ package.json package-lock.json tsconfig.json)
build_dirty=$(git -C "$MC_DIR" status --porcelain -- "${BUILD_PATHS[@]}" 2>/dev/null)
if [[ -n "$build_dirty" ]]; then
  nbuild=$(printf '%s\n' "$build_dirty" | wc -l)
  echo "  uncommitted build inputs ($nbuild; tracked changes and untracked files — a build would compile/use them):"
  printf '%s\n' "$build_dirty" | sed 's/^/    /'
  NOTES+=("$nbuild uncommitted build input(s) under src/ or package/tsconfig files would go into a build")
else
  echo "  uncommitted build inputs (src/, package.json, package-lock.json, tsconfig.json): none"
fi
other_dirty=$(git -C "$MC_DIR" diff --name-only HEAD -- . ':(exclude)src' ':(exclude)package.json' ':(exclude)package-lock.json' ':(exclude)tsconfig.json' 2>/dev/null)
if [[ -n "$other_dirty" ]]; then
  echo "  other uncommitted tracked files (informational; not build inputs):"
  printf '%s\n' "$other_dirty" | sed 's/^/    /'
else
  echo "  other uncommitted tracked files: none"
fi
svc=$(systemctl is-active mission-control 2>/dev/null)
echo "  systemctl is-active mission-control: ${svc:-unknown}"
[[ "$svc" == "active" ]] || NOTES+=("mission-control is '${svc:-unknown}', not active")
echo "  live dist/ built from: unknown (scripts/deploy.sh does not record the built commit)"
if [[ -f "$MC_DIR/dist/index.js" ]]; then
  dist_t=$(stat -c %Y "$MC_DIR/dist/index.js")
  head_t=$(git -C "$MC_DIR" log -1 --format=%ct HEAD 2>/dev/null || echo 0)
  echo "  dist/index.js built: $(date -u -d "@$dist_t" +%Y-%m-%dT%H:%M:%SZ); HEAD committed: $(date -u -d "@$head_t" +%Y-%m-%dT%H:%M:%SZ)"
  if ((dist_t < head_t)); then
    echo "  → dist/ predates HEAD: the live service does not run HEAD (expected before this deploy; expected live build $LIVE_REF)"
  fi
fi
echo

# ---------------------------------------------------------------- B, C, D
helper_out=$(cd "$MC_DIR" && "$TSX" "$HELPER" --db "$DB" --queries "$KB_QUERIES" 2>&1)
helper_rc=$?
printf '%s\n' "$helper_out" | grep -v -e '^@@status ' -e '^npm notice '
status_line=$(printf '%s\n' "$helper_out" | grep '^@@status ' | tail -1)
field() { sed -n "s/.* $1=\([^ ]*\).*/\1/p" <<<"$status_line"; }
if [[ $helper_rc -ne 0 || -z "$status_line" ]]; then
  CHECK_FAILED+=("helper (sections B–D) exited $helper_rc without a status line")
else
  [[ "$(field census)" == "ok" ]] || NOT_READY+=("credential census errored")
  [[ "$(field kb)" == "ok" ]] || NOT_READY+=("KB timing errored")
  coll=$(field collisions)
  [[ "$coll" == "0" ]] || NOT_READY+=("$coll reference-name collision(s) — a hidden value's name changes")
  dd=$(field display_disagree)
  [[ "$dd" == "0" ]] || NOTES+=("${dd:-?} project leaf/leaves where the display verdict (projectEntryLeaves) differs from the index walk")
  slow=$(field kb_slow)
  [[ "$slow" == "0" ]] || NOTES+=("$slow KB query/queries over 500 ms — consider lowering FTS_FETCH_CAP")
  tl=$(field toolless)
  if [[ "$tl" == "error" ]]; then
    NOT_READY+=("tool-less schedule query errored")
  elif [[ "$tl" != "0" ]]; then
    NOTES+=("$tl active tool-less schedule(s) — matter only under INFERENCE_PRIMARY_PROVIDER=openai")
  fi
fi
echo

# ---------------------------------------------------------------- E
echo "E. Shell-gate differential (ruling 5e) vs $LIVE_REF (the live build)"
if [[ "${SKIP_SHELL_DIFF:-0}" == "1" ]]; then
  echo "  skipped (SKIP_SHELL_DIFF=1)"
  NOTES+=("shell-gate differential skipped")
elif ! git -C "$MC_DIR" check-ignore -q data/predeploy/probe; then
  echo "  NOT RUN: data/predeploy/ is not gitignored in $MC_DIR — refusing to write command text there"
  CHECK_FAILED+=("data/predeploy/ not gitignored")
else
  OUTDIR="$MC_DIR/data/predeploy"
  mkdir -p "$OUTDIR" && chmod 700 "$OUTDIR"
  out="$OUTDIR/shell-gate-diff-$(date -u +%Y%m%dT%H%M%SZ).txt"
  (umask 077 && cd "$MC_DIR" && "$TSX" "$DIFF_SCRIPT" --run --ref "$LIVE_REF" >"$out" 2>&1)
  diff_rc=$?
  chmod 600 "$out"
  echo "  exit: $diff_rc"
  completed=1
  for g in docker-refused-per-ruling docker-newly-allowed non-docker; do
    n=$(sed -n "s/^## $g (\([0-9]*\))\$/\1/p" "$out" | tail -1)
    [[ -n "$n" ]] || completed=0
    echo "  $g: ${n:-n/a}"
  done
  echo "  full output (root-only, mode 600; may quote logged commands): $out"
  if ((!completed)); then
    echo "  the differential did not complete (no per-group counts in its output)"
    NOT_READY+=("shell differential did not complete (exit $diff_rc, no per-group counts) — see $out")
  else
  case "$diff_rc" in
    0) ;;
    1) NOT_READY+=("shell differential: unexplained differences (exit 1) — read $out") ;;
    2) NOTES+=("shell differential compared nothing (exit 2: no shell_exec command found in mc.db's logged JSON in 30 days — the ruling 5e differential needs a logging source first)") ;;
    3) NOT_READY+=("shell differential errored (exit 3) — see $out") ;;
    *) NOT_READY+=("shell differential exited $diff_rc") ;;
  esac
  fi
fi
echo

# ---------------------------------------------------------------- F
echo "F. Owed items this script cannot check"
baseline="$MC_DIR/src/tuning/eval-baseline.json"
captured=$(sed -n 's/.*"capturedAt": *"\([^"]*\)".*/\1/p' "$baseline" 2>/dev/null)
head_date=$(git -C "$MC_DIR" log -1 --format=%cI HEAD 2>/dev/null)
case "$EVAL_GATE_VERDICT" in
  PASS)
    echo "  [x] Paid eval gate: PASS — stated by operator (EVAL_GATE_VERDICT), not verified by this script."
    ;;
  FAIL)
    echo "  [!] Paid eval gate: FAIL — stated by operator (EVAL_GATE_VERDICT); do not ship on FAIL."
    NOT_READY+=("eval gate FAIL (stated by operator)")
    ;;
  *)
    echo "  [ ] Paid eval gate (npm run eval:gate -- --run) on the final text; do not ship on FAIL."
    echo "      A compare run records nothing; the committed incumbent (src/tuning/eval-baseline.json) was"
    echo "      captured ${captured:-unknown}, HEAD committed ${head_date:-unknown} → cannot tell whether it ran —"
    echo "      owed per docs/planning/rulings-1-5-wip-resume.md (\"Order to finish\" 5). Set EVAL_GATE_VERDICT to state it."
    NOTES+=("paid eval gate owed (EVAL_GATE_VERDICT not set)")
    ;;
esac
echo "  [ ] Ruling 5a: give Jarvis's psql a non-superuser DB role (psql escapes \\!, \\o |, COPY … PROGRAM stay open until then)."
echo "  [ ] Residuals to know at deploy: the secret index can be up to 60 s stale for out-of-process edits;"
echo "      values persisted before the deploy stay in clear at rest (never sent to a model in clear; backfill optional)."
echo

# ---------------------------------------------------------------- G
echo "G. Verdict (sections A–E + the eval-gate item; the other F items are owed regardless)"
if ((${#CHECK_FAILED[@]})); then
  echo "VERDICT: CHECK FAILED"
  for r in "${CHECK_FAILED[@]}" "${NOT_READY[@]}"; do echo "  - $r"; done
  exit 2
fi
if ((${#NOT_READY[@]})); then
  echo "VERDICT: NOT READY"
  for r in "${NOT_READY[@]}"; do echo "  - $r"; done
  if ((${#NOTES[@]})); then
    echo "  notes:"
    for r in "${NOTES[@]}"; do echo "  - $r"; done
  fi
  exit 1
fi
if ((${#NOTES[@]})); then
  echo "VERDICT: READY WITH NOTES"
  for r in "${NOTES[@]}"; do echo "  - $r"; done
else
  echo "VERDICT: READY"
fi
echo "This script does not deploy; the deploy decision and its command are the operator's."
exit 0
