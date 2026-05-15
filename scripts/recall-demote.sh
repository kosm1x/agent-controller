#!/usr/bin/env bash
# Mission-control .env recall demote — Queue #15 verdict (2026-05-15).
#
# Companion to the docs+memory bundle that closes queue #15. Flips
# HINDSIGHT_RECALL_ENABLED true → false (global recall demote) and clears
# HINDSIGHT_RECALL_DISABLED_BANKS (per-bank list is redundant once global
# is off). Hindsight container, retain/reflect paths, and cost-ledger
# pull-job are NOT touched — only the synchronous recall hop is demoted.
#
# Idempotent: second run is a no-op.
#
# Why: 30-day data + 3-day post-#7-ship sample show
#   mc-jarvis on SQLite-hybrid: 38.9% utility, 301ms latency
#   mc-operational on Hindsight: 4.0% utility, 2496ms latency
# The "<20% utility AND >50% latency tax" threshold from the rehab playbook
# is comprehensively blown. The L4 layer the strategic-options doc planned
# is already serving traffic better than L5 (Hindsight). No 2-week wiring
# needed — this is a 1-line config change.
#
# Escape hatch: callers can still opt into the cross-encoder reranker on
# demand via RecallOptions.withRerank=true (queue #10 mechanism). The
# Hindsight container itself stays up; retain/reflect/observation paths
# continue to populate long-term memory.
#
# Revert: cp -p the timestamped backup file printed below + restart.
# See feedback_hindsight_demote_verdict_2026_05_15.md for full context.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/claude/mission-control/.env}"
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# 1. Backup first (revert is a one-line cp from this file)
cp -p "$ENV_FILE" "$BACKUP"
echo "Backup written to: $BACKUP"

# Prune backups older than 30 days (matches cutover-env-cleanup.sh policy).
find "$(dirname "$ENV_FILE")" -maxdepth 1 -type f \
  \( -name "$(basename "$ENV_FILE").bak.*" \
     -o -name "$(basename "$ENV_FILE").revert-bak.*" \) \
  -mtime +30 -delete 2>/dev/null || true

# 2. Flip HINDSIGHT_RECALL_ENABLED true → false (anchored to avoid matching
#    HINDSIGHT_ENABLED, which is a different variable).
sed -i 's/^HINDSIGHT_RECALL_ENABLED=true$/HINDSIGHT_RECALL_ENABLED=false/' "$ENV_FILE"

# 3. Clear HINDSIGHT_RECALL_DISABLED_BANKS — the per-bank disable list is
#    redundant once global is off. Replace with empty value rather than
#    removing the line, so the variable name stays documented in .env.
sed -i 's/^HINDSIGHT_RECALL_DISABLED_BANKS=.*/HINDSIGHT_RECALL_DISABLED_BANKS=/' "$ENV_FILE"

# 4. Show the delta so you can verify before restart
echo "=== Diff vs backup ==="
diff "$BACKUP" "$ENV_FILE" || true

# 5. Sanity check — Hindsight container path still configured (retain/reflect
#    and cost-ledger pull-job still need these), only RECALL is demoted.
echo
echo "=== Sanity check (only RECALL_ENABLED should be false) ==="
grep -nE '^HINDSIGHT' "$ENV_FILE" || echo "WARNING: no HINDSIGHT_* vars found"

# 6. Explicit post-flip assertion — eliminates "did the sed actually match" doubt.
echo
if grep -q '^HINDSIGHT_RECALL_ENABLED=false$' "$ENV_FILE"; then
  echo "✓ HINDSIGHT_RECALL_ENABLED=false (demote applied)"
else
  echo "✗ FLIP DID NOT APPLY — current value:"
  grep -nE '^HINDSIGHT_RECALL_ENABLED=' "$ENV_FILE" || echo "  (line missing entirely)"
  exit 2
fi

echo
echo "Done. Review the diff above. To apply:"
echo "  sudo systemctl restart mission-control"
echo
echo "To revert:"
echo "  cp -p $BACKUP $ENV_FILE && sudo systemctl restart mission-control"
