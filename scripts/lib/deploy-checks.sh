#!/usr/bin/env bash
# This file can only be loaded in an operator context: every function below
# builds, snapshots or restarts the service. The gate runs before any of them
# is defined; outside an operator context it ends the sourcing shell (exit 2),
# and a gate that returns instead of exiting still stops the load here.
if ! declare -F require_operator_context >/dev/null; then
  # shellcheck source=scripts/lib/operator-gate.sh
  source "$(dirname "${BASH_SOURCE[0]}")/operator-gate.sh"
fi
require_operator_context || return 2 2>/dev/null || exit 2

# The decisions behind scripts/deploy.sh. deploy_run is the ordered sequence;
# every other function is one decision, testable on its own with stub commands
# (scripts/deploy-checks.test.ts).
#
# What a deploy guarantees, and why:
# - Every refusal (dirty tree, host dependencies, running tasks, migration
#   gate, snapshot) happens before the build writes dist/. The service and
#   every unattended restart path boot whatever dist/ holds, so a refused
#   deploy must leave dist/ as the running process last saw it.
# - A deploy that will migrate the live database snapshots it first, so the
#   migration can be undone from a known copy.
# - "OK" means the new process kept one PID for the stability window, answered
#   loopback health with its messaging channels connected, and logged no fatal
#   or uncaught line since the restart. A crash loop or a dead channel is FAILED.
# - Every attempt leaves one provenance line (tag mc-deploy) in the system log,
#   so a refused, blocked or failed deploy stays answerable afterwards.
# - Journal lines can carry message text: only counts are printed, never lines.
# - Liveness is read from /proc; nothing here sends a signal.
#
# Sourced from the repository root. External commands are variables so tests
# substitute stubs; scripts/deploy.sh assigns their real values before sourcing.

_DEPLOY_LIB_DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/code-paths.sh
source "$_DEPLOY_LIB_DIR/code-paths.sh"

: "${SYSTEMCTL:=systemctl}" "${JOURNALCTL:=journalctl}" "${CURL:=curl}"
: "${SQLITE3:=sqlite3}" "${LOGGER:=logger}" "${GIT:=git}" "${NODE:=node}"
: "${PROC_ROOT:=/proc}"
: "${DEPLOY_SERVICE:=mission-control}"
: "${DEPLOY_DB:=data/mc.db}"
# scripts/backup-db.sh writes <repo>/backups/mc-<local date>.db.
: "${DEPLOY_BACKUP_DIR:=backups}"
# Loopback peers get the detailed payload (messaging channel state); port = config.port default.
: "${DEPLOY_HEALTH_URL:=http://127.0.0.1:8080/health}"
: "${DEPLOY_STABLE_SECS:=15}"
: "${DEPLOY_HEALTH_WAIT_SECS:=60}"
: "${DEPLOY_POLL_SECS:=2}"
: "${MC_DEPLOY_TIMEOUT_SECS:=300}"

# Fatal: the logger's fatal level, uncaught exceptions, and Node's own crash
# print (an Error class name at line start; logger lines start with "{").
_DEPLOY_FATAL_RE='"level":"fatal"|[Uu]ncaught|UnhandledPromiseRejection|^[A-Z][A-Za-z]*Error: '
# Error: the logger's error level (the unhandled-rejection handler logs here).
_DEPLOY_ERROR_RE='"level":"error"'

_deploy_say() { echo "[deploy] $*"; }

# ---------------------------------------------------------------- provenance

# One line per attempt to the system log and to stdout. $1 = verdict word
# (OK, WARNING, REFUSED, BLOCKED, FAILED), $2 = the step that decided it.
deploy_provenance() {
  local line
  line="commit=${DEPLOY_COMMIT:-unknown} dirty=${DEPLOY_DIRTY:-unknown} allow_dirty=${DEPLOY_ALLOW_DIRTY:-no}"
  line+=" old_pid=${DEPLOY_OLD_PID:-none} new_pid=${DEPLOY_NEW_PID:-none} verdict=$1 step=$2"
  if ! "$LOGGER" -t mc-deploy -- "$line" 2>/dev/null; then
    _deploy_say "note: the provenance line could not be written to the system log"
  fi
  _deploy_say "provenance: $line"
}

# Logs provenance and returns $3, so a caller can `{ _deploy_end …; return; }`.
_deploy_end() {
  deploy_provenance "$1" "$2"
  return "$3"
}

# ----------------------------------------------------------------- arguments

deploy_usage() {
  echo "Usage: ./scripts/deploy.sh [--force] [--drain <seconds>] [--allow-dirty]"
  echo "  --force         restart even while tasks are running (they are killed)"
  echo "  --drain <secs>  wait up to <secs> for running tasks to finish (default 0 = no wait)"
  echo "  --allow-dirty   deploy uncommitted code changes (recorded in the provenance line)"
}

# Sets FORCE, DRAIN_SECS, DEPLOY_ALLOW_DIRTY. Returns 2 on a bad argument: a
# --drain typo must be loud, never a silent 0.
deploy_parse_args() {
  FORCE="no"; DRAIN_SECS=0; DEPLOY_ALLOW_DIRTY="no"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) FORCE="yes"; shift ;;
      --allow-dirty) DEPLOY_ALLOW_DIRTY="yes"; shift ;;
      --drain)
        if [[ -z "${2:-}" ]] || [[ ! "$2" =~ ^[0-9]+$ ]]; then
          _deploy_say "--drain requires a non-negative integer (seconds). Got: '${2:-<missing>}'"
          return 2
        fi
        DRAIN_SECS="$2"; shift 2 ;;
      *) _deploy_say "unknown arg: $1"; deploy_usage; return 2 ;;
    esac
  done
}

# ---------------------------------------------------------------- dirty tree

# Refuses when code paths (scripts/lib/code-paths.sh) differ from HEAD, unless
# --allow-dirty: what runs must be a commit. Sets DEPLOY_DIRTY.
deploy_check_dirty() {
  local files n
  if ! files=$(code_dirty_files); then
    _deploy_say "REFUSED — git could not report the working tree state."
    return 1
  fi
  if [[ -z "$files" ]]; then
    DEPLOY_DIRTY="no"
    _deploy_say "Working tree clean on the build paths (commit ${DEPLOY_COMMIT:-unknown})."
    return 0
  fi
  DEPLOY_DIRTY="yes"
  n=$(grep -c '' <<<"$files")
  if [[ "${DEPLOY_ALLOW_DIRTY:-no}" == "yes" ]]; then
    _deploy_say "WARNING — ${n} code file(s) differ from ${DEPLOY_COMMIT:-HEAD}; --allow-dirty given, deploying them:"
  else
    _deploy_say "REFUSED — ${n} code file(s) differ from ${DEPLOY_COMMIT:-HEAD} (modified or untracked):"
  fi
  head -n 10 <<<"$files" | sed 's/^/[deploy]     /'
  if [[ "$n" -gt 10 ]]; then _deploy_say "    … and $((n - 10)) more"; fi
  if [[ "${DEPLOY_ALLOW_DIRTY:-no}" == "yes" ]]; then return 0; fi
  _deploy_say "Commit them first, or pass --allow-dirty to deploy the working tree as it is."
  return 1
}

# --------------------------------------------------------- host dependencies

# Compares npm's own install record (node_modules/.package-lock.json) with
# package-lock.json, package by package. Read-only, no network.
_DEPLOY_DEPS_JS='
const fs = require("fs");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8")).packages || {};
let want, have;
try { want = read("package-lock.json"); } catch (e) { console.log("package-lock.json unreadable"); process.exit(1); }
try { have = read("node_modules/.package-lock.json"); } catch (e) { console.log("node_modules/.package-lock.json missing or unreadable (no install record)"); process.exit(1); }
const out = [];
for (const [k, v] of Object.entries(want)) {
  if (!k.startsWith("node_modules/") || v.link) continue;
  const h = have[k];
  if (!h) { if (!v.optional && !v.devOptional && !v.peer) out.push("missing " + k.slice(13) + "@" + v.version); continue; }
  if (h.version !== v.version) out.push(k.slice(13) + " installed " + h.version + ", lockfile " + v.version);
}
for (const k of Object.keys(have)) if (k.startsWith("node_modules/") && !want[k]) out.push("not in lockfile " + k.slice(13));
for (const l of out.slice(0, 10)) console.log(l);
if (out.length > 10) console.log("… and " + (out.length - 10) + " more");
process.exit(out.length ? 1 : 0);
'

deploy_check_host_deps() {
  local out
  if out=$("$NODE" -e "$_DEPLOY_DEPS_JS" 2>&1); then
    _deploy_say "Host node_modules matches package-lock.json."
    return 0
  fi
  _deploy_say "REFUSED — host node_modules does not match package-lock.json:"
  sed 's/^/[deploy]     /' <<<"$out"
  _deploy_say "Fix (operator, one step at a time; step 2 needs the service STOPPED — never install under it):"
  _deploy_say "  1. systemctl stop ${DEPLOY_SERVICE}"
  _deploy_say "  2. cd $(pwd) && npm ci"
  _deploy_say "  3. systemctl start ${DEPLOY_SERVICE}"
  _deploy_say "  4. ./scripts/deploy.sh"
  return 1
}

# ----------------------------------------------------------- running tasks

_deploy_task_count() {
  local n
  n=$("$SQLITE3" -readonly "$DEPLOY_DB" "SELECT COUNT(*) FROM tasks WHERE status='$1';" 2>/dev/null)
  if [[ "$n" =~ ^[0-9]+$ ]]; then echo "$n"; else echo 0; fi
}

# Blocks while tasks are `running` (mid-execution, with side effects) unless
# --force; --drain waits for them first. `queued` tasks are listed, never
# blocking. $1 = pre-build | pre-restart: the second run catches a task that
# started during the build, when the new build is already on disk.
deploy_task_guard() {
  local phase="$1" running queued t0 last=0 d
  [[ -f "$DEPLOY_DB" ]] || return 0
  running=$(_deploy_task_count running)
  queued=$(_deploy_task_count queued)
  if [[ "$running" -gt 0 ]] && [[ "${DRAIN_SECS:-0}" -gt 0 ]]; then
    _deploy_say "$running task(s) running — draining for up to ${DRAIN_SECS}s..."
    t0=$SECONDS
    while :; do
      sleep "$DEPLOY_POLL_SECS"
      running=$(_deploy_task_count running)
      [[ "$running" -eq 0 ]] && break
      d=$((SECONDS - t0))
      (( d >= DRAIN_SECS )) && break
      if (( d / 10 > last )); then last=$((d / 10)); _deploy_say "  drained ${d}s — still running=$running"; fi
    done
  fi
  if [[ "$running" -gt 0 ]] && [[ "${FORCE:-no}" != "yes" ]]; then
    _deploy_say "BLOCKED — $running task(s) currently running (queued=$queued):"
    "$SQLITE3" -readonly -separator '  ' "$DEPLOY_DB" \
      "SELECT task_id, agent_type, substr(title,1,60) FROM tasks WHERE status='running' ORDER BY started_at LIMIT 10;" \
      2>/dev/null | sed 's/^/  /'
    if [[ "$phase" == "pre-restart" ]]; then
      _deploy_say "The NEW BUILD IS ALREADY ON DISK under the old process: re-run the deploy to the end"
      _deploy_say "now (--drain <secs> or --force), before anything else restarts the service."
    else
      _deploy_say "Nothing was built. Pass --drain <secs> to wait, or --force to restart anyway. See feedback_check_inflight_tasks_before_restart."
    fi
    return 1
  fi
  if [[ "$running" -gt 0 ]]; then
    _deploy_say "WARN: $running task(s) still running, --force given — restart will kill them."
  elif [[ "$queued" -gt 0 ]]; then
    _deploy_say "note: $queued queued task(s) will be re-failed by boot-time reconciler."
  fi
  return 0
}

# --------------------------------------------------------- migration gate

deploy_run_migration_validator() {
  npx tsx scripts/validate-migration-runner.ts fresh "$1"
}

# Boots a FRESH throwaway database through initDatabase. The head version is
# read from the runner's own "[db] schema migration vN applied" lines: on a
# fresh database every SCHEMA_MIGRATIONS entry must apply, in order, from v1,
# and user_version must end at the highest one; baseline_history must be
# absent as a table key. Sets DEPLOY_EXPECTED_VERSION (empty when skipped).
deploy_migration_preflight() {
  local tmp json applied head="" uv i=0 v ok="yes"
  DEPLOY_EXPECTED_VERSION=""
  if [[ "${MC_SKIP_MIGRATION_GATE:-0}" == "1" ]]; then
    _deploy_say "Migration preflight SKIPPED (MC_SKIP_MIGRATION_GATE=1)."
    return 0
  fi
  _deploy_say "Migration preflight (fresh-boot schema gate)..."
  tmp="$(mktemp -d)"
  if ! deploy_run_migration_validator "$tmp/fresh.db" > "$tmp/out.json" 2> "$tmp/err.log"; then
    _deploy_say "REFUSED — migration validator errored:"
    cat "$tmp/err.log"
    rm -rf "$tmp"; return 1
  fi
  applied=$(grep -oE '^\[db\] schema migration v[0-9]+ applied' "$tmp/out.json" | grep -oE '[0-9]+' || true)
  for v in $applied; do
    i=$((i + 1))
    if [[ "$v" -ne "$i" ]]; then ok="no"; fi
    head="$v"
  done
  # The validator prints migration log lines ahead of the JSON signature, and
  # one of them says "drop baseline_history": test the table KEY on the JSON line only.
  json=$(grep '"mode":"fresh"' "$tmp/out.json" | tail -1)
  uv=$(grep -oE '"userVersion": *[0-9]+' <<<"$json" | grep -oE '[0-9]+$' || true)
  if [[ "$ok" == "yes" && -n "$head" && -n "$json" && "$uv" == "$head" ]] \
    && ! grep -q '"baseline_history":' <<<"$json"; then
    DEPLOY_EXPECTED_VERSION="$head"
    _deploy_say "Migration gate OK — fresh boot applied v1..v${head} in order, user_version=${uv}, baseline_history absent."
    rm -rf "$tmp"; return 0
  fi
  _deploy_say "REFUSED — fresh-boot schema signature unexpected (want v1..vN applied in order, user_version=N, no baseline_history table; got applied='$(tr '\n' ' ' <<<"$applied")' user_version='${uv}'):"
  cat "$tmp/out.json"
  rm -rf "$tmp"; return 1
}

# --------------------------------------------------------------- snapshot

deploy_run_snapshot_helper() {
  bash scripts/backup-db.sh
}

# Runs scripts/backup-db.sh and proves its output independently: the helper's
# exit status is its last echo, so the snapshot file itself is checked (fresh
# mtime, non-empty, same user_version as the live database).
deploy_take_snapshot() {
  local live="$1" start path snap_v mtime final
  start=$(date +%s)
  if ! deploy_run_snapshot_helper; then
    _deploy_say "REFUSED — the snapshot helper failed; nothing was built."
    return 1
  fi
  path="${DEPLOY_BACKUP_DIR}/mc-$(date +%Y-%m-%d).db"
  mtime=$(stat -c %Y "$path" 2>/dev/null || echo 0)
  if [[ ! -s "$path" ]] || [[ "$mtime" -lt "$start" ]]; then
    _deploy_say "REFUSED — no fresh snapshot at $path; nothing was built."
    return 1
  fi
  snap_v=$("$SQLITE3" -readonly "$path" 'PRAGMA user_version;' 2>/dev/null)
  if [[ "$snap_v" != "$live" ]]; then
    _deploy_say "REFUSED — snapshot $path reports schema v${snap_v:-?}, live is v${live}; nothing was built."
    return 1
  fi
  # Out of the helper's mc-*.db rotation and its same-day overwrite.
  final="${DEPLOY_BACKUP_DIR}/pre-migrate-v${live}-${DEPLOY_COMMIT:-unknown}-$(date +%s).db"
  if ! mv -- "$path" "$final" || [[ ! -s "$final" ]]; then
    _deploy_say "REFUSED — could not keep the snapshot as $final; nothing was built."
    return 1
  fi
  _deploy_say "Snapshot taken before the build (the migration runs at the restart): $final (schema v${live}); it replaces today's date-named mc-*.db and is kept until removed by hand."
}

# Snapshot only when the new code will migrate the live database (live
# user_version below the fresh-boot head), or when the gate was skipped and
# the head is unknown.
deploy_snapshot_decision() {
  local live expected="${DEPLOY_EXPECTED_VERSION:-}"
  if [[ ! -f "$DEPLOY_DB" ]]; then
    _deploy_say "No live database at $DEPLOY_DB — no snapshot."
    return 0
  fi
  live=$("$SQLITE3" -readonly "$DEPLOY_DB" 'PRAGMA user_version;' 2>/dev/null)
  if [[ ! "$live" =~ ^[0-9]+$ ]]; then
    _deploy_say "REFUSED — could not read the live schema version (sqlite3 -readonly); nothing was built."
    return 1
  fi
  if [[ -z "$expected" ]]; then
    _deploy_say "Expected schema version unknown (migration gate skipped) — taking a snapshot of live v${live}."
  elif [[ "$live" -lt "$expected" ]]; then
    _deploy_say "Live schema v${live} < v${expected}: this deploy runs a migration — taking a snapshot first."
  else
    if [[ "$live" -gt "$expected" ]]; then
      _deploy_say "WARNING — live schema v${live} is AHEAD of the new code's head v${expected} (an older build?); the runner skips versions above its head."
    fi
    _deploy_say "Live schema v${live}, new code head v${expected}: no migration will run, no snapshot taken."
    return 0
  fi
  deploy_take_snapshot "$live"
}

# ------------------------------------------------------------ build steps

deploy_build() {
  npm run build
}

deploy_build_info() {
  bash scripts/build-info.sh
}

# The sandbox executes the HOST dist/ (read-only mount) on top of the IMAGE's
# node_modules, so the image must come from the same package-lock.json; the
# runners refuse to spawn on drift (imageLockDrift). Rebuilding here keeps
# that state transient.
deploy_image_gate() {
  local image="mission-control:latest" host_lock image_lock
  host_lock=$(sha256sum package-lock.json | cut -d' ' -f1)
  image_lock=$(docker image inspect "$image" --format '{{ index .Config.Labels "mc.lock-sha256" }}' 2>/dev/null || echo "")
  if [[ "$image_lock" != "$host_lock" ]]; then
    _deploy_say "Sandbox image lockfile drift (image=${image_lock:-<none>} host=${host_lock:0:12}…) — rebuilding $image..."
    bash scripts/build-mc-image.sh
  else
    _deploy_say "Sandbox image lockfile matches host (${host_lock:0:12}…)."
  fi
}

# ---------------------------------------------------------- service state

_deploy_main_pid() {
  local p
  p=$("$SYSTEMCTL" show -p MainPID --value "$DEPLOY_SERVICE" 2>/dev/null)
  if [[ "$p" =~ ^[0-9]+$ ]]; then echo "$p"; else echo 0; fi
}

_deploy_nrestarts() {
  local n
  n=$("$SYSTEMCTL" show -p NRestarts --value "$DEPLOY_SERVICE" 2>/dev/null)
  if [[ "$n" =~ ^[0-9]+$ ]]; then echo "$n"; else echo 0; fi
}

# True when $1 is a numeric pid > 1 with a /proc entry. No signal is sent.
deploy_pid_alive() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [[ "$1" -gt 1 ]] && [[ -d "$PROC_ROOT/$1" ]]
}

# Last totalTools value logged by the unit, for the journal match in "$@".
_deploy_tool_count() {
  "$JOURNALCTL" "$@" -o cat --no-pager 2>/dev/null \
    | grep -oE '"totalTools":[0-9]+' | tail -1 | grep -oE '[0-9]+$' || true
}

# Reads loopback health. Sets DEPLOY_HEALTH_CODE and DEPLOY_HEALTH_CHANNELS
# ("name=true|false" per channel from the payload's `messaging` map).
_DEPLOY_CHANNELS_JS='
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let m;
  try { m = JSON.parse(s).messaging; } catch { return; }
  if (!m || typeof m !== "object") return;
  for (const [k, v] of Object.entries(m)) console.log(k.replace(/[^A-Za-z0-9:_.-]/g, "?") + "=" + (v === true));
});
'
deploy_read_health() {
  local resp body=""
  resp=$("$CURL" -s -m 5 -w '\n%{http_code}' "$DEPLOY_HEALTH_URL" 2>/dev/null)
  DEPLOY_HEALTH_CODE="${resp##*$'\n'}"
  [[ "$DEPLOY_HEALTH_CODE" =~ ^[0-9]{3}$ ]] || DEPLOY_HEALTH_CODE="000"
  if [[ "$resp" == *$'\n'* ]]; then body="${resp%$'\n'*}"; fi
  DEPLOY_HEALTH_CHANNELS=$(printf '%s' "$body" | "$NODE" -e "$_DEPLOY_CHANNELS_JS" 2>/dev/null || true)
}

# Counts fatal and error lines on stdin. Prints "<fatal> <error>".
deploy_count_log_levels() {
  local text fatal error
  text=$(cat)
  fatal=$(grep -cE "$_DEPLOY_FATAL_RE" <<<"$text" || true)
  error=$(grep -cE "$_DEPLOY_ERROR_RE" <<<"$text" || true)
  echo "${fatal:-0} ${error:-0}"
}

# Before the restart: old PID, its tool count, its connected channels, the
# restart counter, and the timestamp every after-restart journal read starts at.
deploy_capture_baseline() {
  DEPLOY_OLD_PID=$(_deploy_main_pid)
  DEPLOY_NRESTARTS_PRE=$(_deploy_nrestarts)
  DEPLOY_PREV_TOOLS=""
  if [[ "$DEPLOY_OLD_PID" =~ ^[1-9][0-9]*$ ]]; then
    DEPLOY_PREV_TOOLS=$(_deploy_tool_count "_SYSTEMD_UNIT=${DEPLOY_SERVICE}.service" "_PID=${DEPLOY_OLD_PID}")
  fi
  deploy_read_health
  DEPLOY_PREV_CHANNELS="$DEPLOY_HEALTH_CHANNELS"
  DEPLOY_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
}

deploy_restart() {
  "$SYSTEMCTL" daemon-reload && "$SYSTEMCTL" restart "$DEPLOY_SERVICE"
}

# Waits until MainPID changed AND the old PID is gone: MainPID can move to the
# new process while the old one is still draining. Polls at least once.
deploy_wait_old_exit() {
  local t0=$SECONDS last=0 new="$DEPLOY_OLD_PID" old_dead="no" elapsed
  DEPLOY_NEW_PID="$DEPLOY_OLD_PID"
  _deploy_say "Waiting for old PID to exit..."
  while :; do
    sleep "$DEPLOY_POLL_SECS"
    new=$(_deploy_main_pid)
    old_dead="yes"
    if [[ "$DEPLOY_OLD_PID" != "0" ]] && deploy_pid_alive "$DEPLOY_OLD_PID"; then old_dead="no"; fi
    if [[ "$new" != "0" && "$new" != "$DEPLOY_OLD_PID" && "$old_dead" == "yes" ]]; then
      DEPLOY_NEW_PID="$new"
      _deploy_say "Old PID gone, new MainPID=$new after $((SECONDS - t0))s."
      return 0
    fi
    elapsed=$((SECONDS - t0))
    (( elapsed >= MC_DEPLOY_TIMEOUT_SECS )) && break
    if (( elapsed / 10 > last )); then
      last=$((elapsed / 10))
      _deploy_say "  ${elapsed}s — newPid=$new oldDead=$old_dead"
    fi
  done
  if [[ "$old_dead" == "no" ]]; then
    _deploy_say "FAILED — old PID $DEPLOY_OLD_PID still alive after ${MC_DEPLOY_TIMEOUT_SECS}s (MainPID=$new)."
  else
    _deploy_say "FAILED — MainPID did not change within ${MC_DEPLOY_TIMEOUT_SECS}s (oldPid=$DEPLOY_OLD_PID, current=$new)."
  fi
  DEPLOY_NEW_PID="$new"
  return 1
}

# After the old PID is gone. Returns 0 = OK, 1 = FAILED, 3 = up with warnings.
deploy_post_restart_check() {
  local t0 pid active nr_start nr_end failed=0 warned=0 tools counts fatal errors
  local want line name ok got_any boot_pid="$DEPLOY_NEW_PID"
  # (1)+(2) one PID, unit active, no automatic restart for the whole window.
  # Polls at least once, whatever the window length.
  nr_start=$(_deploy_nrestarts)
  t0=$SECONDS
  while :; do
    sleep "$DEPLOY_POLL_SECS"
    pid=$(_deploy_main_pid)
    active=$("$SYSTEMCTL" is-active "$DEPLOY_SERVICE" 2>/dev/null)
    if [[ "$pid" != "$DEPLOY_NEW_PID" || "$active" != "active" ]]; then
      _deploy_say "FAILED — restart loop: MainPID ${DEPLOY_NEW_PID} → ${pid}, unit ${active:-unknown}, within ${DEPLOY_STABLE_SECS}s."
      DEPLOY_NEW_PID="$pid"
      failed=1
      break
    fi
    (( SECONDS - t0 >= DEPLOY_STABLE_SECS )) && break
  done
  # A rise inside the window is an automatic restart; so is a counter above 0
  # at the window's start when it was 0 before the restart. The pre-restart
  # value is not compared otherwise: whether a manual restart resets it is
  # systemd's business, not this check's.
  nr_end=$(_deploy_nrestarts)
  if [[ "$nr_end" -gt "$nr_start" ]]; then
    _deploy_say "FAILED — restart loop: NRestarts rose ${nr_start} → ${nr_end} during the window."
    failed=1
  elif [[ "$nr_start" -gt 0 && "${DEPLOY_NRESTARTS_PRE:-}" == "0" ]]; then
    _deploy_say "FAILED — restart loop: NRestarts 0 before the restart, ${nr_start} at the window's start."
    failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    _deploy_say "Stable — MainPID ${DEPLOY_NEW_PID} active for ${DEPLOY_STABLE_SECS}s, NRestarts unchanged."
  fi

  # (3) loopback health 200, and every channel connected before the restart
  # connected again (with no baseline: at least one channel connected).
  if [[ "$failed" -eq 0 ]]; then
    t0=$SECONDS
    while :; do
      deploy_read_health
      ok="no"
      if [[ "$DEPLOY_HEALTH_CODE" == "200" ]]; then
        ok="yes"; got_any="no"
        while IFS= read -r line; do
          [[ "$line" == *=true ]] && got_any="yes"
        done <<<"$DEPLOY_HEALTH_CHANNELS"
        want=$(grep '=true$' <<<"${DEPLOY_PREV_CHANNELS:-}" | sed 's/=true$//' || true)
        if [[ -n "$want" ]]; then
          while IFS= read -r name; do
            grep -qxF "${name}=true" <<<"$DEPLOY_HEALTH_CHANNELS" || ok="no"
          done <<<"$want"
        elif [[ "$got_any" != "yes" ]]; then
          ok="no"
        fi
      fi
      [[ "$ok" == "yes" ]] && break
      (( SECONDS - t0 >= DEPLOY_HEALTH_WAIT_SECS )) && break
      sleep "$DEPLOY_POLL_SECS"
    done
    if [[ "$DEPLOY_HEALTH_CODE" != "200" ]]; then
      _deploy_say "FAILED — loopback health answered ${DEPLOY_HEALTH_CODE} (want 200) for ${DEPLOY_HEALTH_WAIT_SECS}s."
      failed=1
    elif [[ "$ok" != "yes" ]]; then
      if [[ -n "$want" ]]; then
        while IFS= read -r name; do
          grep -qxF "${name}=true" <<<"$DEPLOY_HEALTH_CHANNELS" \
            || _deploy_say "FAILED — channel ${name} was connected before the restart and is not now."
        done <<<"$want"
      else
        _deploy_say "FAILED — no messaging channel connected (loopback health 'messaging' map)."
      fi
      failed=1
    else
      _deploy_say "Health 200; channels: $(tr '\n' ' ' <<<"$DEPLOY_HEALTH_CHANNELS")"
    fi
  fi

  # (4) tool count vs the previous boot: fewer tools is a warning (removal is legitimate).
  # (4) and (5) read only the new process's lines (one PID, proven above).
  tools=$(_deploy_tool_count "_SYSTEMD_UNIT=${DEPLOY_SERVICE}.service" "_PID=${boot_pid}" --since "$DEPLOY_SINCE")
  if [[ -z "$tools" ]]; then
    _deploy_say "WARNING — no tool count line from this boot."
    warned=1
  elif [[ -n "${DEPLOY_PREV_TOOLS:-}" && "$tools" -lt "$DEPLOY_PREV_TOOLS" ]]; then
    _deploy_say "WARNING — tool count dropped: ${DEPLOY_PREV_TOOLS} before, ${tools} now."
    warned=1
  else
    _deploy_say "Tools: ${tools} (previous boot: ${DEPLOY_PREV_TOOLS:-unknown})."
  fi

  # (5) fatal / error lines since the restart. Counts only.
  counts=$("$JOURNALCTL" "_SYSTEMD_UNIT=${DEPLOY_SERVICE}.service" "_PID=${boot_pid}" --since "$DEPLOY_SINCE" -o cat --no-pager 2>/dev/null \
    | deploy_count_log_levels)
  fatal=${counts% *}; errors=${counts#* }
  if [[ "$fatal" -gt 0 ]]; then
    _deploy_say "FAILED — ${fatal} fatal/uncaught line(s) in the journal since the restart."
    failed=1
  fi
  if [[ "$errors" -gt 0 ]]; then
    _deploy_say "WARNING — ${errors} error-level line(s) in the journal since the restart."
    warned=1
  fi
  if [[ "$failed" -eq 0 && "$warned" -eq 0 ]]; then
    _deploy_say "No fatal or error-level lines since the restart."
  fi

  if [[ "$failed" -ne 0 || "$warned" -ne 0 ]]; then
    _deploy_say "Inspect: journalctl _SYSTEMD_UNIT=${DEPLOY_SERVICE}.service _PID=${boot_pid} --since '${DEPLOY_SINCE}'"
    _deploy_say "To roll back: re-deploy the previous commit from a clean checkout."
  fi
  if [[ "$failed" -ne 0 ]]; then return 1; fi
  if [[ "$warned" -ne 0 ]]; then return 3; fi
  return 0
}

# ------------------------------------------------------------- sequence

# The deploy, in order. Each refusal comes before the build; each exit logs
# provenance. Runs with errexit off: every step's status is checked here, so
# the same code paths run under deploy.sh and under the tests.
deploy_run() {
  declare -F require_operator_context >/dev/null && require_operator_context \
    || { echo "[deploy] REFUSED — operator gate unavailable or refused; nothing ran." >&2; return 2; }
  set +e
  DEPLOY_COMMIT=$("$GIT" rev-parse --short HEAD 2>/dev/null) || DEPLOY_COMMIT="unknown"
  DEPLOY_DIRTY=""; DEPLOY_OLD_PID=""; DEPLOY_NEW_PID=""
  deploy_parse_args "$@" || { _deploy_end REFUSED args 2; return; }
  deploy_check_dirty || { _deploy_end REFUSED dirty-tree 1; return; }
  deploy_check_host_deps || { _deploy_end REFUSED host-deps 1; return; }
  deploy_task_guard pre-build || { _deploy_end BLOCKED task-guard 1; return; }
  deploy_migration_preflight || { _deploy_end REFUSED migration-gate 1; return; }
  deploy_snapshot_decision || { _deploy_end REFUSED snapshot 1; return; }

  _deploy_say "Building..."
  local half="dist/ may now hold part of the new build under the old process: fix it and re-run the deploy to the end."
  deploy_build || { _deploy_say "FAILED — build. $half"; _deploy_end FAILED build 1; return; }
  deploy_build_info || { _deploy_say "FAILED — build-info. $half"; _deploy_end FAILED build-info 1; return; }
  deploy_image_gate || { _deploy_say "FAILED — sandbox image rebuild. $half"; _deploy_end FAILED image 1; return; }
  deploy_task_guard pre-restart || { _deploy_end BLOCKED task-guard-pre-restart 1; return; }

  deploy_capture_baseline
  _deploy_say "Old MainPID=$DEPLOY_OLD_PID. Reloading systemd + restarting..."
  deploy_restart || { _deploy_say "FAILED — systemctl restart. $half"; _deploy_end FAILED restart 1; return; }
  deploy_wait_old_exit || { _deploy_end FAILED old-pid 1; return; }

  deploy_post_restart_check
  case $? in
    0) _deploy_say "OK — commit=${DEPLOY_COMMIT} dirty=${DEPLOY_DIRTY} newPid=${DEPLOY_NEW_PID} (was ${DEPLOY_OLD_PID})."
       _deploy_end OK post-restart 0 ;;
    3) _deploy_say "WARNING — deployed and up, see the warnings above (newPid=${DEPLOY_NEW_PID})."
       _deploy_end WARNING post-restart 0 ;;
    *) _deploy_end FAILED post-restart 1 ;;
  esac
}
