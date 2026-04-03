/**
 * Google OAuth2 token management.
 *
 * Handles access token refresh using the stored refresh token.
 * Tokens are cached in memory and refreshed 5 minutes before expiry.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_MS = 300_000; // 5 minutes before expiry

let cachedToken: string | null = null;
let expiresAt = 0;

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function getConfig(): GoogleAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN",
    );
  }

  return { clientId, clientSecret, refreshToken };
}

/**
 * Get a valid access token. Refreshes automatically if expired.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < expiresAt - REFRESH_MARGIN_MS) {
    return cachedToken;
  }

  const config = getConfig();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = data.access_token;
  expiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

/** Check if Google auth is configured. */
export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
}

/** Reset cached token (for testing). */
export function resetTokenCache(): void {
  cachedToken = null;
  expiresAt = 0;
}
