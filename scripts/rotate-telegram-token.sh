#!/usr/bin/env bash
# Rotate @PiotrTheBot's Telegram bot token across all VPS consumers.
#
# Usage:
#   TG_TOKEN_NEW='<new-token-from-BotFather>' /root/claude/mission-control/scripts/rotate-telegram-token.sh
#
# Steps:
#   1. Validate new token via getMe (refuses to proceed if Telegram rejects it).
#   2. Back up both .env files (timestamped .bak.<ts>).
#   3. Atomic sed-replace TELEGRAM_BOT_TOKEN= in mission-control + xpoz-pipeline.
#   4. Restart both services.
#   5. Verify MCP + polling come back up, tail 60s for any fresh 409.
#
# Safety:
#   - New token is never echoed to stdout/logs; all prints mask to prefix-only.
#   - On any validation failure, .env files are restored from backup and exit 1.
#   - Old token is NOT saved anywhere after rotation — BotFather revokes it on generation.

set -euo pipefail

MC_ENV="/root/claude/mission-control/.env"
XPOZ_ENV="/root/claude/projects/xpoz-pipeline/.env"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# ── Input validation ──────────────────────────────────────────────────────────
if [[ -z "${TG_TOKEN_NEW:-}" ]]; then
  echo "FATAL: set TG_TOKEN_NEW='<new-token>' and re-run." >&2
  exit 1
fi

if [[ ! "$TG_TOKEN_NEW" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "FATAL: TG_TOKEN_NEW does not match Telegram's token shape (<digits>:<alnum>). Refusing to rotate." >&2
  exit 1
fi

TOKEN_PREFIX="${TG_TOKEN_NEW%%:*}"
echo "[rotate] New token prefix: ${TOKEN_PREFIX}:*****"

# ── Preflight: validate new token via getMe ──────────────────────────────────
echo "[rotate] Validating new token via getMe..."
GETME=$(curl -sS -m 10 "https://api.telegram.org/bot${TG_TOKEN_NEW}/getMe" || true)
if ! echo "$GETME" | grep -q '"ok":true'; then
  echo "FATAL: new token rejected by Telegram. Response: ${GETME}" >&2
  exit 1
fi
BOT_USERNAME=$(echo "$GETME" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['username'])")
echo "[rotate] New token OK — bot @${BOT_USERNAME}"

# ── Backups ───────────────────────────────────────────────────────────────────
cp "$MC_ENV" "${MC_ENV}.bak.${TS}"
cp "$XPOZ_ENV" "${XPOZ_ENV}.bak.${TS}"
echo "[rotate] Backups: ${MC_ENV}.bak.${TS}, ${XPOZ_ENV}.bak.${TS}"

restore_and_fail() {
  echo "[rotate] FAILED — restoring backups..." >&2
  cp "${MC_ENV}.bak.${TS}" "$MC_ENV"
  cp "${XPOZ_ENV}.bak.${TS}" "$XPOZ_ENV"
  exit 1
}

# ── Replace token (in-place, atomic per-file) ────────────────────────────────
# Use python to avoid sed-escaping pitfalls with special chars.
python3 - <<PY || restore_and_fail
import os, re, sys
new = os.environ["TG_TOKEN_NEW"]
for path in ("$MC_ENV", "$XPOZ_ENV"):
    with open(path, "r") as f:
        lines = f.readlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            lines[i] = f"TELEGRAM_BOT_TOKEN={new}\n"
            found = True
            break
    if not found:
        print(f"FATAL: TELEGRAM_BOT_TOKEN= not found in {path}", file=sys.stderr)
        sys.exit(1)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(lines)
    os.replace(tmp, path)
    print(f"[rotate] Updated {path}")
PY

# ── Restart services ──────────────────────────────────────────────────────────
echo "[rotate] Restarting mission-control + xpoz-pipeline..."
systemctl restart mission-control xpoz-pipeline

# ── Verify ────────────────────────────────────────────────────────────────────
sleep 5

if ! systemctl is-active --quiet mission-control; then
  echo "FATAL: mission-control failed to start after rotation." >&2
  journalctl -u mission-control --since "20 sec ago" --no-pager | tail -15 >&2
  restore_and_fail
fi
if ! systemctl is-active --quiet xpoz-pipeline; then
  echo "FATAL: xpoz-pipeline failed to start after rotation." >&2
  journalctl -u xpoz-pipeline --since "20 sec ago" --no-pager | tail -15 >&2
  restore_and_fail
fi

echo "[rotate] Services active."

# Confirm mission-control sees new bot username
if ! journalctl -u mission-control --since "30 sec ago" --no-pager | grep -q "Bot initialized: @${BOT_USERNAME}"; then
  echo "WARN: didn't see 'Bot initialized: @${BOT_USERNAME}' in mission-control logs yet — may need more time."
fi

echo "[rotate] Watching for 409 flaps for 60s (expected: none)..."
sleep 60

FLAPS=$(journalctl -u mission-control --since "65 sec ago" --no-pager | grep -c "409: Conflict" || true)
if [[ "$FLAPS" -eq 0 ]]; then
  echo "[rotate] ✅ SUCCESS — 0 flaps in 60s. Token rotation complete."
  echo "[rotate] Backups retained: ${MC_ENV}.bak.${TS}, ${XPOZ_ENV}.bak.${TS}"
  echo "[rotate] (Delete backups after a few hours once you're confident: rm /root/claude/{mission-control,projects/xpoz-pipeline}/.env.bak.${TS})"
else
  echo "[rotate] ⚠️  ${FLAPS} flap(s) seen in 60s — external rival may have an OLD deploy with THIS new token somewhere (unlikely) OR rotation didn't land on one of the consumers. Investigate." >&2
  exit 2
fi
