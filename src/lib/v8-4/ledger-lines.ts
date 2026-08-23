/**
 * The one place that knows what a ledger-rendered line looks like.
 *
 * Every surface that must treat the completion ledger's appended text as
 * harness output — the deliverable filter's content guard, the router's
 * background-notification cap, the stop hook, the ledger renderers — reads
 * this predicate instead of re-typing a prefix list (R3 audit: a whitelist
 * in the router missed the two classes appended last and dropped a
 * «No quedó» from an "Agente terminó" notice). Dependency-free on purpose.
 */

export const READBACK_PREFIX = "readback:";

/** Prefixes of every line the completion ledger can append to a deliverable. */
export const LEDGER_LINE_PREFIXES: readonly string[] = [
  "✔ Verificado:",
  "⚠️ No quedó:",
  "⏳ Sin releer",
  "Gates:", // the enforce-mode block is ONE line joined with " · "
];

export function isLedgerLine(line: string): boolean {
  const t = line.trim();
  return LEDGER_LINE_PREFIXES.some((p) => t.startsWith(p));
}

export function isReadbackCheck(
  check_kind: string,
  check_cmd: string | null | undefined,
): boolean {
  return check_kind === "manual" && !!check_cmd?.startsWith(READBACK_PREFIX);
}
