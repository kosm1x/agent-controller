/**
 * Error-message extraction for a `catch (e: unknown)` block that needs
 * a human-readable message: an Error's own message, else the value's text
 * form; an empty text, or an Error message that is not a string, is replaced
 * by a fixed sentence, and a message or text form whose reading throws by
 * another.
 */

/**
 * Extract a readable message from an unknown catch value. When that text is
 * the empty string (an Error without a message, a thrown "") or an Error's
 * message is not a string at run time, a fixed sentence is returned instead:
 * a reader that tests an error text by truth would take an empty or falsy one
 * for no error at all. A throw while reading the message or the text form (an
 * object with no prototype, a throwing getter, a revoked proxy) is caught
 * here and gives a second fixed sentence, so it does not reach the catch
 * block that called this.
 */
export function errMsg(e: unknown): string {
  let text: unknown;
  try {
    text = e instanceof Error ? e.message : String(e);
  } catch {
    return "(unreadable error)";
  }
  return typeof text !== "string" || text === ""
    ? "unknown error (no message given)"
    : text;
}
