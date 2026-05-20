#!/usr/bin/env bash
#
# activate-briefing-delivery.sh — V8.1 Phase 9 activation helper.
#
# Flips V81_BRIEF_DELIVERY_ENABLED in the mission-control .env and restarts the
# service so systemd reloads the EnvironmentFile and the change takes effect.
#
#   ON  → operator-facing briefing delivery is activated: the morning-surface
#         trigger delivers the constructed briefing, and the scheduler skips
#         the legacy morning-briefing ritual (exactly one morning brief).
#   OFF → reverts to the legacy ritual; the new pipeline goes back to
#         generate-and-persist only.
#
# This is a CODE-FREE change (an env flip, not a redeploy) — no build needed.
# See the activation runbook in docs/V8.1-GUIDE.md.
#
# Usage:  sudo ./scripts/activate-briefing-delivery.sh [on|off]   (default: on)

set -euo pipefail

KEY="V81_BRIEF_DELIVERY_ENABLED"
SERVICE="mission-control"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# --- args -------------------------------------------------------------------
MODE="${1:-on}"
case "$MODE" in
  on)  VALUE="true" ;;
  off) VALUE="false" ;;
  *)   echo "Usage: $0 [on|off]   (default: on)" >&2; exit 2 ;;
esac

# --- preconditions ----------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root — edits .env and restarts $SERVICE." >&2
  echo "       Re-run with: sudo $0 $MODE" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

echo "=== V8.1 briefing delivery → ${MODE^^}  (${KEY}=${VALUE}) ==="

# --- 1. back up .env --------------------------------------------------------
BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
echo "[1/4] Backed up .env → ${BACKUP}"

# --- 2. apply the flag ------------------------------------------------------
# Match the key whether it is currently set, commented, or absent.
CURRENT="$(grep -E "^[[:space:]]*#?[[:space:]]*${KEY}=" "$ENV_FILE" | tail -1 || true)"
echo "[2/4] Current: ${CURRENT:-<not set>}"

if grep -qE "^[[:space:]]*#?[[:space:]]*${KEY}=" "$ENV_FILE"; then
  sed -i -E "s|^[[:space:]]*#?[[:space:]]*${KEY}=.*|${KEY}=${VALUE}|" "$ENV_FILE"
else
  printf '\n# V8.1 Phase 9 — operator-facing briefing delivery toggle\n%s=%s\n' \
    "$KEY" "$VALUE" >> "$ENV_FILE"
fi
echo "[2/4] New:     $(grep -E "^${KEY}=" "$ENV_FILE" | tail -1)"

# --- 3. restart + verify the PID transition --------------------------------
OLD_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
echo "[3/4] Restarting ${SERVICE} (old MainPID=${OLD_PID})..."
systemctl restart "$SERVICE"

NEW_PID="$OLD_PID"
for _ in $(seq 1 30); do
  sleep 1
  NEW_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  if [ "$STATE" = "active" ] && [ "$NEW_PID" != "0" ] && [ "$NEW_PID" != "$OLD_PID" ]; then
    break
  fi
done

if [ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" != "active" ]; then
  echo "ERROR: ${SERVICE} is NOT active after restart." >&2
  echo "       Inspect:  journalctl -u ${SERVICE} -n 50 --no-pager" >&2
  echo "       Restore:  cp ${BACKUP} ${ENV_FILE} && systemctl restart ${SERVICE}" >&2
  exit 1
fi
echo "[3/4] ${SERVICE} active — new MainPID=${NEW_PID} (was ${OLD_PID})"

# --- 4. confirm the value actually reached the running process -------------
# If this shows <NOT LOADED>, the systemd unit EnvironmentFile= does not
# point at this .env — editing the file alone then has no effect.
LIVE="$(tr '\0' '\n' < "/proc/${NEW_PID}/environ" 2>/dev/null | grep "^${KEY}=" || true)"
echo "[4/4] In running process: ${LIVE:-<NOT LOADED - is the systemd EnvironmentFile set?>}"

echo
if [ "$VALUE" = "true" ]; then
  echo "✅ Briefing delivery is ON."
  echo "   The morning-surface trigger now delivers; the legacy ritual is skipped."
  echo "   After a few days of live runs, check the activation gate:"
  echo "     ./mc-ctl briefing-gate"
  echo "   Revert any time with:  sudo $0 off"
else
  echo "↩️  Briefing delivery is OFF — reverted to the legacy morning ritual."
fi
