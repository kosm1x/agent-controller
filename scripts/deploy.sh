#!/bin/bash
# Build from source and restart the service, refusing before the build when
# anything would make the result unsafe or unrecorded, and reporting FAILED
# when the new process does not stay up. The decisions and their reasons live
# in scripts/lib/deploy-checks.sh (deploy_run is the ordered sequence).
# Usage: ./scripts/deploy.sh [--force] [--drain <seconds>] [--allow-dirty]
#   --force         restart even while tasks are running (they are killed)
#   --drain <secs>  wait up to <secs> for running tasks to finish (default 0 = no wait)
#   --allow-dirty   deploy uncommitted code changes (recorded in the provenance line)
# Env: MC_SKIP_MIGRATION_GATE=1 skips the fresh-boot schema gate (known-safe
# emergency deploy only; a snapshot is then always taken);
# MC_DEPLOY_TIMEOUT_SECS (default 300) bounds the wait for the old PID to exit.
set -e
cd /root/claude/mission-control
# Operator context only (login session, pipes allowed); a task runs inside
# mission-control.service and is refused before anything runs.
# shellcheck source=scripts/lib/operator-gate.sh
source scripts/lib/operator-gate.sh
require_operator_context

# The real commands and window lengths, set here so a stray environment value
# cannot swap a command or shorten a check. The tests source the lib directly
# with stubs; MC_DEPLOY_TIMEOUT_SECS and MC_SKIP_MIGRATION_GATE stay the only knobs.
SYSTEMCTL=systemctl JOURNALCTL=journalctl CURL=curl SQLITE3=sqlite3 LOGGER=logger GIT=git NODE=node
PROC_ROOT=/proc DEPLOY_SERVICE=mission-control DEPLOY_DB=data/mc.db DEPLOY_BACKUP_DIR=backups
DEPLOY_HEALTH_URL=http://127.0.0.1:8080/health DEPLOY_STABLE_SECS=15 DEPLOY_HEALTH_WAIT_SECS=60 DEPLOY_POLL_SECS=2

# shellcheck source=scripts/lib/deploy-checks.sh
source scripts/lib/deploy-checks.sh
deploy_run "$@"
