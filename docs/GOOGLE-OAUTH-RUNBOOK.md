# Google OAuth Token Refresh Runbook

When Google tools fail with `invalid_grant` (refresh token expired/revoked), follow these steps.

> **Faster path**: `./scripts/reissue-google-token.sh` automates steps 3–5. Run with no args for instructions, then re-run with the refresh token as the first arg.

Google killed the OOB redirect flow (`urn:ietf:wg:oauth:2.0:oob`) in 2022. This runbook uses the OAuth Playground flow instead.

## 1. Authorize the Playground redirect URI (one-time setup)

Open https://console.cloud.google.com/apis/credentials, edit the OAuth client whose ID matches `$GOOGLE_CLIENT_ID` in `.env`, and add this to **Authorized redirect URIs** if not already present:

```
https://developers.google.com/oauthplayground
```

Save. Changes can take a few minutes to propagate.

## 2. Get a refresh token from the Playground

Open https://developers.google.com/oauthplayground.

1. Gear icon (top right) → check **Use your own OAuth credentials**.
2. Paste `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `.env`. Close the panel.
3. Scroll the left column to **Input your own scopes** and paste (space-separated):

```
https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/tasks
```

4. Click **Authorize APIs** → approve the consent screen.
5. Click **Exchange authorization code for tokens**.
6. Copy the value of `refresh_token` from the response panel.

## 3. Update .env

```bash
sed -i 's|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=<NEW_REFRESH_TOKEN>|' /root/claude/mission-control/.env
```

## 4. Restart

```bash
systemctl restart mission-control
```

## 5. Verify

```bash
source /root/claude/mission-control/.env
curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_REFRESH_TOKEN&grant_type=refresh_token" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'access_token' in d else f'FAIL: {d}')"
```

## Notes

- All 19+ Google Workspace tools (Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks) share the same token.
- Refresh tokens expire when: revoked manually, unused for 6 months, password changed, OAuth app in "Testing" status (7-day cap), or Google security policy triggers revocation.
- If the OAuth consent screen says your app is in "Testing" status, consider publishing it in Google Cloud Console → OAuth consent screen → PUBLISH APP. Testing-mode refresh tokens die every 7 days regardless of use.
