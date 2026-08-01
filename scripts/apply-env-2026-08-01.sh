#!/usr/bin/env bash
#
# One-shot operator env apply — 2026-08-01.
#
# Two unrelated changes, deliberately coupled into ONE restart so the operator
# takes a single service bounce (and a single trailing alert message):
#
#   1. V8.3 canary widening — `V83_GATED_CAPABILITIES` goes from one capability
#      to the four whose tools actually reach the router confirm seam. Without
#      this, the CAPABILITY_BY_TOOL additions in src/lib/v8-3/trigger.ts are
#      inert: `delete_schedule` maps to `schedule_task`, which was not armed.
#      Effect: confirmed destructive actions stop executing unlogged, and the
#      §14 shadow-decision counter (0/7 as of today) can finally move.
#
#   2. Alert re-nag off — `ALERT_RENOTIFY_HOURS=0` restores pure notify-once.
#      Salon 54444db3 has been logged_out since 07-29 and needs a manual
#      re-link (RUNBOOK §5), so its ONE firing critical was re-announced every
#      6h = 4 unsolicited Telegram messages/day about a state nothing automatic
#      can clear. Newly-firing and resolved alerts STILL announce; only the
#      periodic reminder is suppressed.
#      TRADEOFF (2026-06-12 note in prometheus-alert-poller.ts): a MISSED first
#      announcement can now become a silent outage. Set 24 for a daily reminder
#      instead of 0, or delete the line to restore the 6h default.
#
# Idempotent: re-running makes no further change. Backs up both drop-ins first.
# Read-only preflight aborts before touching anything if dist/ is stale.
#
# Usage:  bash /root/claude/mission-control/scripts/apply-env-2026-08-01.sh
#         (add --dry-run to print the plan and exit)

set -euo pipefail

DROPIN_DIR=/etc/systemd/system/mission-control.service.d
CANARY_CONF="$DROPIN_DIR/v83-canary.conf"
ALERT_CONF="$DROPIN_DIR/alert-notify.conf"
DIST_TRIGGER=/root/claude/mission-control/dist/lib/v8-3/trigger.js
STAMP=$(date +%Y%m%d-%H%M%S)

NEW_CANARY='jarvis_file_delete,gmail_send,northstar_sync,schedule_task'
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SUDO=''
[[ $EUID -ne 0 ]] && SUDO='sudo'

say() { printf '  %s\n' "$*"; }
die() { printf '\n✗ ABORT: %s\n' "$*" >&2; exit 1; }

echo
echo "=== Preflight ==============================================="

[[ -f "$CANARY_CONF" ]] || die "missing $CANARY_CONF"
[[ -f "$ALERT_CONF"  ]] || die "missing $ALERT_CONF"

# The canary widening is pointless unless the compiled map carries the new
# tool→capability entries. Catches "edited source, forgot npm run build".
if ! grep -q 'delete_schedule: "schedule_task"' "$DIST_TRIGGER" 2>/dev/null; then
  die "dist/ is stale — delete_schedule mapping absent from $DIST_TRIGGER.
         Run: cd /root/claude/mission-control && npm run build"
fi
say "✓ dist/ carries the delete_schedule → schedule_task mapping"

say "current: $(grep -h '^Environment=V83_GATED_CAPABILITIES=' "$CANARY_CONF" || echo '(unset)')"
say "current: $(grep -h '^Environment=ALERT_RENOTIFY_HOURS=' "$ALERT_CONF" || echo '(unset — defaults to 6h)')"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "--dry-run: would set V83_GATED_CAPABILITIES=$NEW_CANARY"
  echo "           would set ALERT_RENOTIFY_HOURS=0"
  echo "           would daemon-reload + restart mission-control"
  exit 0
fi

echo
echo "=== Backup =================================================="
$SUDO cp -a "$CANARY_CONF" "$CANARY_CONF.bak-$STAMP"
$SUDO cp -a "$ALERT_CONF"  "$ALERT_CONF.bak-$STAMP"
say "✓ $CANARY_CONF.bak-$STAMP"
say "✓ $ALERT_CONF.bak-$STAMP"

echo
echo "=== 1/2  V8.3 canary ========================================"
if grep -q '^Environment=V83_GATED_CAPABILITIES=' "$CANARY_CONF"; then
  $SUDO sed -i "s|^Environment=V83_GATED_CAPABILITIES=.*|Environment=V83_GATED_CAPABILITIES=$NEW_CANARY|" "$CANARY_CONF"
  say "✓ replaced existing line"
else
  printf 'Environment=V83_GATED_CAPABILITIES=%s\n' "$NEW_CANARY" | $SUDO tee -a "$CANARY_CONF" >/dev/null
  say "✓ appended (no prior line)"
fi
say "now: $(grep -h '^Environment=V83_GATED_CAPABILITIES=' "$CANARY_CONF")"

echo
echo "=== 2/2  Alert re-nag ======================================="
if grep -q '^Environment=ALERT_RENOTIFY_HOURS=' "$ALERT_CONF"; then
  $SUDO sed -i 's|^Environment=ALERT_RENOTIFY_HOURS=.*|Environment=ALERT_RENOTIFY_HOURS=0|' "$ALERT_CONF"
  say "✓ replaced existing line"
else
  $SUDO tee -a "$ALERT_CONF" >/dev/null <<'EOF'

# 2026-08-01 — stop the 6h re-nag. Salon 54444db3 is logged_out since 07-29 and
# needs a manual re-link (RUNBOOK §5), so its one firing critical re-announced
# every 6h. `0` = pure notify-once: newly-firing and resolved alerts STILL
# announce; only the reminder for a still-firing critical is suppressed.
# Set 24 for a daily reminder instead; delete the line to restore the 6h default.
Environment=ALERT_RENOTIFY_HOURS=0
EOF
  say "✓ appended with rationale"
fi
say "now: $(grep -h '^Environment=ALERT_RENOTIFY_HOURS=' "$ALERT_CONF")"

echo
echo "=== Restart ================================================="
$SUDO systemctl daemon-reload
$SUDO systemctl restart mission-control
say "waiting 12s for boot..."
sleep 12

echo
echo "=== Verify =================================================="
STATE=$(systemctl is-active mission-control || true)
say "unit: $STATE"
[[ "$STATE" == "active" ]] || die "mission-control is '$STATE' — check: journalctl -u mission-control -n 50"

# `systemctl cat | grep` prints ONLY these two directives — never dump the full
# Environment block, it carries INFERENCE_*_KEY values.
systemctl cat mission-control \
  | grep -E '^Environment=(ALERT_RENOTIFY_HOURS|V83_GATED_CAPABILITIES)=' \
  | sed 's/^/  live: /'

echo
say "startup log (secrets filtered):"
journalctl -u mission-control --since '1 min ago' --no-pager 2>/dev/null \
  | grep -v -i 'key\|token\|secret' \
  | grep -E 'prometheus-alert-notifier|v8-3|error|Error|listening' \
  | tail -12 | sed 's/^/  /' || true

cat <<'NOTE'

=== Done ====================================================

  EXPECT ONE LAST ALERT MESSAGE within ~2 min of this restart. Criticals are
  deliberately never restart-seeded ("a still-firing critical SHOULD re-surface
  after a restart" — prometheus-alert-poller.ts). After that one, silence.

  Check the V8.3 shadow counter in a week:
      mc-ctl v83-gate

  Rollback (restores both drop-ins, one restart):
      ls /etc/systemd/system/mission-control.service.d/*.bak-*
      # cp -a <chosen .bak> back over the .conf, then:
      systemctl daemon-reload && systemctl restart mission-control

NOTE
