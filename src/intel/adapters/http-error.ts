/**
 * The error an adapter throws for a non-2xx response: status + the start of the
 * body, on one line — it ends up in a journal line, and upstream error pages are
 * multi-line HTML.
 */
export async function httpError(res: Response): Promise<Error> {
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
  return new Error(
    `HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
  );
}
