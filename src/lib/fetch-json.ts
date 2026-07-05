/**
 * Shared JSON fetch — replaces the hand-rolled
 * AbortController + setTimeout + clearTimeout skeleton duplicated across
 * builtin tools (weather, currency, geocoding, rss, exa-search, …).
 *
 * Timeout via AbortSignal.timeout (covers connect + body read). On a
 * non-2xx response the body is read as text and thrown as HttpStatusError,
 * which carries `status` + `bodyText` so callers can reconstruct their
 * exact user-facing error formats.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Non-2xx HTTP response. `bodyText` is the full response body ("" if unreadable). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(label: string, status: number, bodyText: string) {
    const excerpt = bodyText.slice(0, 200).replace(/\s+/g, " ").trim();
    super(`${label} error: ${status}${excerpt ? ` ${excerpt}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

/**
 * Fetch a URL and return its parsed JSON body.
 *
 * @throws HttpStatusError on non-2xx status (message: `${label} error: ${status} …`)
 * @throws DOMException (TimeoutError) when `timeoutMs` elapses
 * @throws SyntaxError when the 2xx body is not valid JSON
 */
export async function fetchJson(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    label?: string;
    method?: string;
    body?: string;
  } = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: opts.method,
    headers: { Accept: "application/json", ...opts.headers },
    ...(opts.body !== undefined && { body: opts.body }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      /* unreadable error body — keep "" */
    }
    throw new HttpStatusError(opts.label ?? "HTTP", response.status, bodyText);
  }

  return response.json() as Promise<unknown>;
}
