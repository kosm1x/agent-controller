#!/usr/bin/env bash
# Mission-control .env cleanup — Anthropic SDK cutover (2026-05-10)
# Companion to commits 5b62c3f + 64071fd (the code-side cutover).
#
# Idempotent: second run is a no-op (only matches lines NOT already commented).
# Targets variable NAMES, not line numbers, so it survives future .env edits.
#
# What this does:
#   - Comments out INFERENCE_{PRIMARY,FALLBACK,TERTIARY}_{URL,KEY,MODEL} so
#     stale Fireworks/Groq endpoint config doesn't sit in process env.
#   - Flips HINDSIGHT_ENABLED=true → false so mission-control stops calling
#     the Hindsight container (CRM keeps using Hindsight independently).
#
# What this preserves (must stay set):
#   - INFERENCE_PRIMARY_PROVIDER=claude-sdk  (the routing flag itself)
#   - INFERENCE_VISION_*                     (Groq vision, deliberately kept)
#   - WHISPER_API_*                          (Groq Whisper, deliberately kept)
#   - HINDSIGHT_RECALL_ENABLED + HINDSIGHT_RECALL_DISABLED_BANKS
#       — different variables, untouched (anchored sed avoids over-match)
#
# Revert: cp -p the timestamped backup file printed below + restart.
# See feedback_anthropic_sdk_cutover_2026_05_10.md for full context.

set -euo pipefail

# ENV_FILE override allows the test harness at /RevertInference/test-revert.sh
# to run this script against a fixture without touching the live .env.
ENV_FILE="${ENV_FILE:-/root/claude/mission-control/.env}"
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# 1. Backup first (revert is a one-line cp from this file)
cp -p "$ENV_FILE" "$BACKUP"
echo "Backup written to: $BACKUP"

# Prune backups older than 30 days (audit W3 follow-up). Covers both
# .bak.* (this script) and .revert-bak.* (RevertInference counterpart).
find "$(dirname "$ENV_FILE")" -maxdepth 1 -type f \
  \( -name "$(basename "$ENV_FILE").bak.*" \
     -o -name "$(basename "$ENV_FILE").revert-bak.*" \) \
  -mtime +30 -delete 2>/dev/null || true

# 2. Comment out OpenAI-compat endpoint vars.
#    Anchored on `^VARNAME=` so a re-run sees `# VARNAME=` and skips.
#    Captures both occurrences of FALLBACK and TERTIARY (env parser takes
#    last-defined, but commenting both is the safe move).
sed -i \
  -e 's/^INFERENCE_PRIMARY_URL=/# INFERENCE_PRIMARY_URL=/' \
  -e 's/^INFERENCE_PRIMARY_KEY=/# INFERENCE_PRIMARY_KEY=/' \
  -e 's/^INFERENCE_PRIMARY_MODEL=/# INFERENCE_PRIMARY_MODEL=/' \
  -e 's/^INFERENCE_FALLBACK_URL=/# INFERENCE_FALLBACK_URL=/' \
  -e 's/^INFERENCE_FALLBACK_KEY=/# INFERENCE_FALLBACK_KEY=/' \
  -e 's/^INFERENCE_FALLBACK_MODEL=/# INFERENCE_FALLBACK_MODEL=/' \
  -e 's/^INFERENCE_TERTIARY_URL=/# INFERENCE_TERTIARY_URL=/' \
  -e 's/^INFERENCE_TERTIARY_KEY=/# INFERENCE_TERTIARY_KEY=/' \
  -e 's/^INFERENCE_TERTIARY_MODEL=/# INFERENCE_TERTIARY_MODEL=/' \
  "$ENV_FILE"

# 3. Flip HINDSIGHT_ENABLED true → false (anchored to avoid matching
#    HINDSIGHT_RECALL_ENABLED, which is a different variable).
sed -i 's/^HINDSIGHT_ENABLED=true$/HINDSIGHT_ENABLED=false/' "$ENV_FILE"

# 4. Flip INFERENCE_PRIMARY_PROVIDER=openai → claude-sdk. Added 2026-05-10
#    after the test harness at /RevertInference/test-revert.sh caught a
#    round-trip asymmetry: revert flips claude-sdk → openai, so the
#    cutover must flip openai → claude-sdk for the two scripts to be
#    symmetric inverses. Idempotent: a re-run on already-claude-sdk is no-op.
sed -i 's/^INFERENCE_PRIMARY_PROVIDER=openai$/INFERENCE_PRIMARY_PROVIDER=claude-sdk/' "$ENV_FILE"

# 5. Show the delta so you can verify before restart
echo "=== Diff vs backup ==="
diff "$BACKUP" "$ENV_FILE" || true

# 6. Sanity check — these MUST still be present and uncommented
echo
echo "=== Sanity check (these should be uncommented) ==="
grep -nE '^(INFERENCE_PRIMARY_PROVIDER|INFERENCE_VISION_|WHISPER_API_)' "$ENV_FILE" \
  || echo "WARNING: expected vars missing"

echo
echo "Done. Review the diff above. To apply:"
echo "  sudo systemctl restart mission-control"
echo
echo "To revert:"
echo "  cp -p $BACKUP $ENV_FILE && sudo systemctl restart mission-control"
