/**
 * Error-message extraction for every `catch (e: unknown)` block that needs
 * a human-readable message: an Error's own message, else the value's text
 * form; an empty text, or an Error message that is not a string, is replaced
 * by a fixed sentence.
 */

/**
 * Extract a readable message from an unknown catch value. When that text is
 * the empty string (an Error without a message, a thrown "") or an Error's
 * message is not a string at run time, a fixed sentence is returned instead:
 * a reader that tests an error text by truth would take an empty or falsy one
 * for no error at all.
 */
export function errMsg(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return typeof text !== "string" || text === ""
    ? "unknown error (no message given)"
    : text;
}
