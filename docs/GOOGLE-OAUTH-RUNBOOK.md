# Google OAuth Token Refresh Runbook

When Google tools fail with `invalid_grant` (refresh token expired/revoked), follow these steps.

## 1. Paste this URL in your browser

Replace `<CLIENT_ID>` with the value from `.env` (`GOOGLE_CLIENT_ID`).

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https%3A//www.googleapis.com/auth/gmail.send%20https%3A//www.googleapis.com/auth/gmail.readonly%20https%3A//www.googleapis.com/auth/drive%20https%3A//www.googleapis.com/auth/calendar%20https%3A//www.googleapis.com/auth/spreadsheets%20https%3A//www.googleapis.com/auth/documents%20https%3A//www.googleapis.com/auth/presentations%20https%3A//www.googleapis.com/auth/tasks&access_type=offline&prompt=consent
```

Sign in and approve all scopes. Copy the authorization code shown.

## 2. Exchange the code for a refresh token

```bash
source /root/claude/mission-control/.env

curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "code=<AUTH_CODE>" \
  -d "client_id=$GOOGLE_CLIENT_ID" \
  -d "client_secret=$GOOGLE_CLIENT_SECRET" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
  -d "grant_type=authorization_code"
```

Copy `refresh_token` from the JSON response.

## 3. Update .env and restart

```bash
# Replace the old token in .env
sed -i 's|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=<NEW_REFRESH_TOKEN>|' /root/claude/mission-control/.env

# Restart
sudo systemctl restart mission-control
```

## 4. Verify

```bash
source /root/claude/mission-control/.env
curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_REFRESH_TOKEN&grant_type=refresh_token" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'access_token' in d else f'FAIL: {d}')"
```

## Notes

- The `urn:ietf:wg:oauth:2.0:oob` redirect is deprecated by Google. If it stops working, use Google OAuth Playground (https://developers.google.com/oauthplayground) with "Use your own OAuth credentials" enabled.
- All 19 Google Workspace tools (Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks) share the same token.
- Refresh tokens expire when: revoked manually, unused for 6 months, password changed, or Google security policy triggers revocation.
