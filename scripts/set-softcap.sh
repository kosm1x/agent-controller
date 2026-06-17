#!/usr/bin/env bash
#
# set-softcap.sh — set the daily budget SOFT CAP (warn-only) for mission-control.
#
# The cap is the env var BUDGET_DAILY_LIMIT_USD, read at BOOT by config.ts
# (`float("BUDGET_DAILY_LIMIT_USD", 10.0)`). It is a SOFT cap by default
# (budgetEnforce=false): crossing it logs a warn + fires the daily budget
# alert but does NOT block tasks. This script edits .env, restarts the
# service, and verifies the live value via /health.
#
# It only touches that ONE key — no other .env line is read or changed — and
# backs up .env first. Env vars are read at boot, so NO rebuild is needed,
# only a restart (unlike source edits, which need ./scripts/deploy.sh).
#
# NOTE: the hourly cap (default $2 → ~$48/24h) is usually the real binding
# constraint; raising the daily cap above ~$48 has no effect unless you also
# raise BUDGET_HOURLY_LIMIT_USD.
#
# Usage:
#   ./scripts/set-softcap.sh                  # show current cap + live spend, no change
#   ./scripts/set-softcap.sh 50               # set cap to $50, restart, verify
#   ./scripts/set-softcap.sh 50 --no-restart  # edit .env only (next restart applies it)
#
set -euo pipefail

KEY="BUDGET_DAILY_LIMIT_USD"
SERVICE="mission-control"
HEALTH_URL="http://localhost:8080/health"

# Resolve repo root from this script's own location (works from any cwd).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"

c_red=$'\033[0;31m'; c_grn=$'\033[0;32m'; c_yel=$'\033[1;33m'; c_dim=$'\033[2m'; c_rst=$'\033[0m'
die()  { echo "${c_red}[softcap] ERROR:${c_rst} $*" >&2; exit 1; }
info() { echo "${c_yel}[softcap]${c_rst} $*"; }
ok()   { echo "${c_grn}[softcap]${c_rst} $*"; }

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"

# Read live values from /health (does NOT read .env secret values).
live_cap()   { curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -o '"dailyLimit":[0-9.]*'  | head -1 | cut -d: -f2; }
live_spend() { curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -o '"dailySpend":[0-9.]*'  | head -1 | cut -d: -f2; }

# ---- no argument: report current state and exit ----
NEW="${1:-}"
if [[ -z "$NEW" ]]; then
  cur="$(grep -E "^${KEY}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  info "current .env  ${KEY}=${cur:-<unset → source default 10.0>}"
  info "live /health  dailyLimit=$(live_cap || echo '?')  dailySpend=\$$(live_spend || echo '?')"
  echo "${c_dim}usage: $0 <amount> [--no-restart]   e.g. $0 50${c_rst}"
  exit 0
fi

# ---- validate the amount: positive number, optional decimals ----
[[ "$NEW" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "amount must be a positive number (got: '$NEW')"
awk "BEGIN{exit !($NEW>0)}" || die "amount must be > 0 (got: '$NEW')"

RESTART=1
[[ "${2:-}" == "--no-restart" ]] && RESTART=0

# ---- back up .env before any edit ----
BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
info "backed up .env → $BACKUP"

# ---- surgical replace-or-append of the active (uncommented) key only ----
OLD="$(grep -E "^${KEY}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
if grep -qE "^${KEY}=" "$ENV_FILE"; then
  sed -i "s|^${KEY}=.*|${KEY}=${NEW}|" "$ENV_FILE"
else
  printf '\n%s=%s\n' "$KEY" "$NEW" >> "$ENV_FILE"
fi
ok "${KEY}: ${OLD:-<unset>} → ${NEW}"

if [[ "$RESTART" -eq 0 ]]; then
  info "--no-restart: .env updated; restart $SERVICE to apply."
  exit 0
fi

# ---- restart, then verify the PID actually changed (async-restart guard) ----
OLD_PID="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
info "restarting $SERVICE (oldPid=$OLD_PID)..."
systemctl restart "$SERVICE"

NEW_PID="$OLD_PID"
for _ in $(seq 1 30); do
  sleep 1
  [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == "active" ]] || continue
  NEW_PID="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
  [[ "$NEW_PID" != "0" && "$NEW_PID" != "$OLD_PID" ]] && break
done
[[ "$(systemctl is-active "$SERVICE")" == "active" ]] || die "$SERVICE not active after restart — journalctl -u $SERVICE -n50"
[[ "$NEW_PID" != "$OLD_PID" && "$NEW_PID" != "0" ]] || die "PID unchanged ($OLD_PID) — restart did not take; check logs"
ok "$SERVICE active (newPid=$NEW_PID, was $OLD_PID)"

# ---- verify the live cap matches what we set ----
LIVE=""
for _ in $(seq 1 15); do
  LIVE="$(live_cap || true)"
  [[ -n "$LIVE" ]] && break
  sleep 1
done
[[ -n "$LIVE" ]] || die "could not read dailyLimit from $HEALTH_URL after restart"

if awk "BEGIN{exit !($LIVE==$NEW)}"; then
  ok "verified live dailyLimit=\$$LIVE  (spent so far today: \$$(live_spend || echo '?'))"
else
  die "live dailyLimit=\$$LIVE != requested \$$NEW — the value may be pinned in the systemd unit's Environment= (overrides .env). Check: systemctl cat $SERVICE"
fi
