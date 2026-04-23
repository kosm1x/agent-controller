#!/usr/bin/env bash
# Reissue Google OAuth refresh token for mission-control.
#
# Usage:
#   ./scripts/reissue-google-token.sh              # print consent URL (step 1)
#   ./scripts/reissue-google-token.sh <auth_code>  # exchange code, update .env, restart, verify
#
# Fires when Google tools log `invalid_grant` / "Token has been expired or revoked".
# See docs/GOOGLE-OAUTH-RUNBOOK.md for the manual equivalent.

set -euo pipefail

ENV_FILE="/root/claude/mission-control/.env"

# shellcheck source=/dev/null
source "$ENV_FILE"

: "${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID missing from $ENV_FILE}"
: "${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET missing from $ENV_FILE}"

CONSENT_URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https%3A//www.googleapis.com/auth/gmail.send%20https%3A//www.googleapis.com/auth/gmail.readonly%20https%3A//www.googleapis.com/auth/drive%20https%3A//www.googleapis.com/auth/calendar%20https%3A//www.googleapis.com/auth/spreadsheets%20https%3A//www.googleapis.com/auth/documents%20https%3A//www.googleapis.com/auth/presentations%20https%3A//www.googleapis.com/auth/tasks&access_type=offline&prompt=consent"

if [[ $# -eq 0 ]]; then
  cat <<EOF
Step 1 — open this URL in your browser, approve all scopes, copy the auth code:

${CONSENT_URL}

Step 2 — run:

  $0 <paste_auth_code_here>

If the OOB flow is rejected (Google has been deprecating it), fall back to
https://developers.google.com/oauthplayground with "Use your own OAuth
credentials" enabled.
EOF
  exit 0
fi

AUTH_CODE="$1"

echo "[1/4] Exchanging authorization code for refresh token..."
RESPONSE="$(curl -sf -X POST "https://oauth2.googleapis.com/token" \
  -d "code=${AUTH_CODE}" \
  -d "client_id=${GOOGLE_CLIENT_ID}" \
  -d "client_secret=${GOOGLE_CLIENT_SECRET}" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
  -d "grant_type=authorization_code")"

NEW_REFRESH_TOKEN="$(printf '%s' "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('refresh_token',''))")"

if [[ -z "$NEW_REFRESH_TOKEN" ]]; then
  echo "FAILED: no refresh_token in response:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

echo "Got refresh_token (${NEW_REFRESH_TOKEN:0:12}...)"

echo "[2/4] Updating ${ENV_FILE} (backup first)..."
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
if grep -q '^GOOGLE_REFRESH_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=${NEW_REFRESH_TOKEN}|" "$ENV_FILE"
else
  printf '\nGOOGLE_REFRESH_TOKEN=%s\n' "$NEW_REFRESH_TOKEN" >> "$ENV_FILE"
fi

echo "[3/4] Restarting mission-control..."
systemctl restart mission-control
sleep 2
systemctl is-active mission-control >/dev/null || { echo "service failed to come back active" >&2; systemctl status mission-control --no-pager | tail -20 >&2; exit 1; }

echo "[4/4] Verifying new refresh token against Google..."
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
