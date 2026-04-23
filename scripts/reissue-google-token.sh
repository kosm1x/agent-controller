#!/usr/bin/env bash
# Reissue Google OAuth refresh token for mission-control.
#
# Usage:
#   ./scripts/reissue-google-token.sh                   # print Playground instructions + scopes
#   ./scripts/reissue-google-token.sh <refresh_token>   # write to .env, restart, verify
#
# Google killed the OOB redirect (urn:ietf:wg:oauth:2.0:oob) in 2022 and is
# actively enforcing. This script uses the OAuth Playground flow instead:
# you get the refresh token directly from the Playground UI and pass it in.
# See docs/GOOGLE-OAUTH-RUNBOOK.md for the manual equivalent.

set -euo pipefail

ENV_FILE="/root/claude/mission-control/.env"

# shellcheck source=/dev/null
source "$ENV_FILE"

: "${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID missing from $ENV_FILE}"
: "${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET missing from $ENV_FILE}"

SCOPES_FILE="/tmp/google-oauth-scopes.txt"
SCOPES="https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/tasks"

if [[ $# -eq 0 ]]; then
  printf '%s\n' "$SCOPES" > "$SCOPES_FILE"

  cat <<EOF
Reissue via OAuth Playground (OOB is blocked by Google as of 2022).

Step 1 — ensure the Playground redirect URI is authorized.
  https://console.cloud.google.com/apis/credentials
  Edit client: ${GOOGLE_CLIENT_ID}
  Add under "Authorized redirect URIs":
    https://developers.google.com/oauthplayground

Step 2 — get a refresh token via Playground.
  https://developers.google.com/oauthplayground

  a) Gear icon (top right) → check "Use your own OAuth credentials".
     Paste CLIENT_ID and CLIENT_SECRET from ${ENV_FILE}. Close panel.
  b) Left column → scroll to "Input your own scopes" → paste (space-separated):

>>>SCOPES_START>>>
${SCOPES}
<<<SCOPES_END<<<

     (also saved to ${SCOPES_FILE} — cat if truncated)

  c) Click "Authorize APIs" → approve in browser.
  d) Click "Exchange authorization code for tokens".
  e) Copy the 'refresh_token' value from the response panel.

Step 3 — feed it back:
  $0 <refresh_token>
EOF
  exit 0
fi

NEW_REFRESH_TOKEN="$1"

# Sanity: Google refresh tokens start with '1//' and are ~100+ chars.
if [[ ! "$NEW_REFRESH_TOKEN" =~ ^1// ]] || [[ ${#NEW_REFRESH_TOKEN} -lt 40 ]]; then
  echo "That does not look like a Google refresh token (expected to start with '1//' and be 100+ chars)." >&2
  echo "If you accidentally pasted an access token (starts with 'ya29.'), go back to Playground and copy the 'refresh_token' field." >&2
  exit 1
fi

echo "Got refresh_token (${NEW_REFRESH_TOKEN:0:12}...)"

echo "[1/3] Updating ${ENV_FILE} (backup first)..."
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
if grep -q '^GOOGLE_REFRESH_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=${NEW_REFRESH_TOKEN}|" "$ENV_FILE"
else
  printf '\nGOOGLE_REFRESH_TOKEN=%s\n' "$NEW_REFRESH_TOKEN" >> "$ENV_FILE"
fi

echo "[2/3] Restarting mission-control..."
systemctl restart mission-control
sleep 2
systemctl is-active mission-control >/dev/null || { echo "service failed to come back active" >&2; systemctl status mission-control --no-pager | tail -20 >&2; exit 1; }

echo "[3/3] Verifying new refresh token against Google..."
# Re-source to pick up the just-written token
# shellcheck source=/dev/null
source "$ENV_FILE"
VERIFY="$(curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=${GOOGLE_CLIENT_ID}&client_secret=${GOOGLE_CLIENT_SECRET}&refresh_token=${GOOGLE_REFRESH_TOKEN}&grant_type=refresh_token")"

if printf '%s' "$VERIFY" | grep -q '"access_token"'; then
  echo "OK — new refresh token works. Drive-sync errors should clear within one ritual cycle."
else
  echo "FAILED verification: $VERIFY" >&2
  exit 1
fi
