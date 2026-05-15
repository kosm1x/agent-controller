#!/usr/bin/env bash
#
# add-email-account.sh — register one mailbox in .env for the multi-mailbox
# email channel (docs/EMAIL-CHANNEL.md). Run once per mailbox; re-running with
# the same id replaces that account's block. The operator runs this — .env is
# permission-protected and Claude cannot write it. No secret is ever stored in
# this script; the password is read interactively and never echoed.
#
# Usage:  ./scripts/add-email-account.sh
#         ENV_FILE=/path/to/.env ./scripts/add-email-account.sh   # testing
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

err()  { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
note() { printf '\033[1;33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m%s\033[0m\n' "$*"; }

[[ -t 0 ]] || { err "This script is interactive — run it in a terminal."; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  err "No .env at $ENV_FILE — the service needs an existing .env. Aborting."
  exit 1
fi

# --- account id -------------------------------------------------------------
while true; do
  read -rp "Account id (lowercase, [a-z0-9_], e.g. comunidades): " ACCOUNT_ID
  [[ "$ACCOUNT_ID" =~ ^[a-z0-9_]+$ ]] && break
  err "Invalid id — must match [a-z0-9_]+ (got: '$ACCOUNT_ID')"
done
ID_UP="$(printf '%s' "$ACCOUNT_ID" | tr '[:lower:]' '[:upper:]')"

if grep -q "^EMAIL_${ID_UP}_" "$ENV_FILE"; then
  note "An EMAIL_${ID_UP}_* block already exists — it will be replaced."
fi

# --- mode -------------------------------------------------------------------
echo
echo "Mode:"
echo "  owner-only         — private Jarvis channel (Telegram-style). Only mail"
echo "                       FROM the operator is read; full tool access."
echo "  community-manager  — public-facing org mailbox. ALL senders are read,"
echo "                       Jarvis replies on behalf of the org with a"
echo "                       restricted (read-only / lookup) tool set."
while true; do
  read -rp "Mode [owner-only | community-manager] (default: owner-only): " MODE
  MODE="${MODE:-owner-only}"
  case "$MODE" in
    owner-only|community-manager) break ;;
    *) err "Must be exactly 'owner-only' or 'community-manager'." ;;
  esac
done

# --- required fields --------------------------------------------------------
req() { # req VARNAME "prompt"
  local _v
  while true; do
    read -rp "$2: " _v
    [[ -n "$_v" ]] && break
    err "Required — cannot be empty."
  done
  printf -v "$1" '%s' "$_v"
}

req IMAP_HOST "IMAP host (e.g. imap.hostinger.com)"
req SMTP_HOST "SMTP host (e.g. smtp.hostinger.com)"
req USERNAME  "Username / login (full email address)"

while true; do
  read -rsp "Password (provider app password — hidden): " PASSWORD; echo
  [[ -n "$PASSWORD" ]] && break
  err "Required — cannot be empty."
done
case "$PASSWORD" in
  *'#'* | *' '* | *$'\t'*)
    note "Note: password contains '#', a space or a tab. systemd reads .env values literally to end-of-line so this should still work, but a provider app-password without those characters is safest." ;;
esac

# Owner address is the sender filter in owner-only mode (required), and the
# optional operator-escalation address in community-manager mode.
if [[ "$MODE" == "owner-only" ]]; then
  req OWNER_ADDRESS "Owner address (ONLY mail from this sender is processed)"
else
  read -rp "Operator escalation address (optional, press Enter to skip): " OWNER_ADDRESS
fi

read -rp "From address [default: $USERNAME]: " FROM_ADDRESS
FROM_ADDRESS="${FROM_ADDRESS:-$USERNAME}"

# Persona file — optional in both modes, but the prompt suggests one in
# community-manager mode where it's the org-context source. Validate the
# path is readable (the service will throw at boot otherwise).
PERSONA_FILE=""
if [[ "$MODE" == "community-manager" ]]; then
  PERSONA_DEFAULT="data/email-personas/${ACCOUNT_ID}.md"
  echo
  echo "Persona file (optional but recommended in community-manager mode):"
  echo "  A markdown file with the org's mission, programs, voice, contacts, and"
  echo "  reply guidelines. Jarvis grounds every reply in it."
  echo "  Suggested location: $PERSONA_DEFAULT (gitignored, edit any time)."
  while true; do
    read -rp "Persona file path (relative to repo root, or absolute; Enter to skip): " PERSONA_FILE
    [[ -z "$PERSONA_FILE" ]] && break
    PERSONA_RESOLVED="$PERSONA_FILE"
    [[ "$PERSONA_FILE" != /* ]] && PERSONA_RESOLVED="$REPO_ROOT/$PERSONA_FILE"
    if [[ -f "$PERSONA_RESOLVED" ]]; then
      break
    fi
    err "File not found: $PERSONA_RESOLVED — type a different path or Enter to skip."
  done
fi

# --- optional numeric fields ------------------------------------------------
numopt() { # numopt VARNAME "prompt" DEFAULT MIN MAX
  local _v
  while true; do
    read -rp "$2 [default: $3]: " _v
    _v="${_v:-$3}"
    if [[ "$_v" =~ ^[0-9]+$ ]] && (( _v >= $4 && _v <= $5 )); then
      printf -v "$1" '%s' "$_v"; break
    fi
    err "Must be an integer $4..$5."
  done
}
numopt IMAP_PORT        "IMAP port"         993   1     65535
numopt SMTP_PORT        "SMTP port"         465   1     65535
numopt POLL_INTERVAL_MS "Poll interval ms"  60000 10000 86400000

# --- confirm ----------------------------------------------------------------
echo
note "About to add this mailbox to $ENV_FILE:"
cat <<SUMMARY
  id              : $ACCOUNT_ID   (channel: email:$ACCOUNT_ID)
  mode            : $MODE
  IMAP            : $IMAP_HOST:$IMAP_PORT
  SMTP            : $SMTP_HOST:$SMTP_PORT
  username        : $USERNAME
  password        : (hidden, ${#PASSWORD} chars)
  from address    : $FROM_ADDRESS
  owner address   : ${OWNER_ADDRESS:-(none — community-manager mode)}
  persona file    : ${PERSONA_FILE:-(none — Jarvis will reply generically)}
  poll interval   : ${POLL_INTERVAL_MS}ms
SUMMARY
read -rp "Proceed? [y/N]: " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { err "Aborted — .env not modified."; exit 1; }

# --- merge into EMAIL_ACCOUNTS ----------------------------------------------
# Read the existing list BEFORE the rewrite strips it. New id goes first; the
# rest are normalised (trimmed, lowercased) and de-duplicated.
CURRENT_ACCOUNTS="$(grep -E '^EMAIL_ACCOUNTS=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
MERGED="$ACCOUNT_ID"
if [[ -n "$CURRENT_ACCOUNTS" ]]; then
  IFS=',' read -ra _existing <<< "$CURRENT_ACCOUNTS"
  for a in "${_existing[@]}"; do
    a="$(printf '%s' "$a" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    [[ -z "$a" || "$a" == "$ACCOUNT_ID" ]] && continue
    MERGED="$MERGED,$a"
  done
fi

# --- backup + rewrite -------------------------------------------------------
# Timestamped + PID-suffixed backup — unique even across same-second runs, and
# the name matches the .env.bak.* .gitignore rule so a secret-bearing backup
# can never be staged.
BACKUP="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)-$$"
cp "$ENV_FILE" "$BACKUP"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Keep every line except the ones this script owns: the global gate, the
# accounts list, this account's block, and this account's marker comment.
# `cat -s` squeezes the blank lines that would otherwise accrue run over run.
grep -vE "^EMAIL_ENABLED=|^EMAIL_ACCOUNTS=|^EMAIL_${ID_UP}_|^# >>> email account: ${ACCOUNT_ID} <<<\$" \
  "$ENV_FILE" | cat -s > "$TMP" || true

{
  printf '\n'
  printf 'EMAIL_ENABLED=true\n'
  printf 'EMAIL_ACCOUNTS=%s\n' "$MERGED"
  printf '# >>> email account: %s <<<\n' "$ACCOUNT_ID"
  printf 'EMAIL_%s_MODE=%s\n'             "$ID_UP" "$MODE"
  printf 'EMAIL_%s_IMAP_HOST=%s\n'        "$ID_UP" "$IMAP_HOST"
  printf 'EMAIL_%s_IMAP_PORT=%s\n'        "$ID_UP" "$IMAP_PORT"
  printf 'EMAIL_%s_SMTP_HOST=%s\n'        "$ID_UP" "$SMTP_HOST"
  printf 'EMAIL_%s_SMTP_PORT=%s\n'        "$ID_UP" "$SMTP_PORT"
  printf 'EMAIL_%s_USERNAME=%s\n'         "$ID_UP" "$USERNAME"
  printf 'EMAIL_%s_PASSWORD=%s\n'         "$ID_UP" "$PASSWORD"
  printf 'EMAIL_%s_ADDRESS=%s\n'          "$ID_UP" "$FROM_ADDRESS"
  # OWNER_ADDRESS line is omitted in community-manager mode if left blank.
  if [[ -n "$OWNER_ADDRESS" ]]; then
    printf 'EMAIL_%s_OWNER_ADDRESS=%s\n'  "$ID_UP" "$OWNER_ADDRESS"
  fi
  if [[ -n "$PERSONA_FILE" ]]; then
    printf 'EMAIL_%s_PERSONA_FILE=%s\n'   "$ID_UP" "$PERSONA_FILE"
  fi
  printf 'EMAIL_%s_POLL_INTERVAL_MS=%s\n' "$ID_UP" "$POLL_INTERVAL_MS"
} >> "$TMP"

# Overwrite .env content in place — `cat >` keeps the file's existing owner
# and permission bits (.env is mode 600), unlike `mv`.
cat "$TMP" > "$ENV_FILE"

ok "Done. $ENV_FILE updated (backup: $BACKUP)."
echo "  EMAIL_ACCOUNTS is now: $MERGED"
echo
note "Next steps:"
echo "  1. Add any other mailboxes:  ./scripts/add-email-account.sh"
echo "  2. Deploy:                   ./scripts/deploy.sh"
echo "  3. Verify in the logs:"
echo "       journalctl -u mission-control --since '1 min ago' | grep -i email"
echo "     expect: [messaging] Email channel active — N mailbox(es)"
echo "             [email:$ACCOUNT_ID] Channel active — polling $IMAP_HOST ..."
echo "  4. Check /health for the email:<id> channel statuses."
