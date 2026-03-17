/**
 * Google API client — raw fetch wrapper with auth.
 *
 * All Google API calls go through this. Handles:
 * - Access token injection
 * - Timeout (10s default)
 * - Error formatting
 * - JSON response parsing
 */

import { getAccessToken } from "./auth.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function googleFetch<T>(
  url: string,
  options?: {
    method?: string;
    body?: unknown;
    timeout?: number;
  },
): Promise<T> {
  const token = await getAccessToken();
  const method = options?.method ?? "GET";
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;

    if (options?.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Google API ${response.status}: ${text.slice(0, 300)}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
