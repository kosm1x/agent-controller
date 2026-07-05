/**
 * Error-message extraction — the `e instanceof Error ? e.message : String(e)`
 * one-liner, centralized. Use in every `catch (e: unknown)` block that needs
 * a human-readable message.
 */

/** Extract a readable message from an unknown catch value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
