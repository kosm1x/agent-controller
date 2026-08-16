/**
 * V8.4 — numbers-provenance audit for delivered reports.
 *
 * unlazy's most reproducible finding: reports whose numbers were wrong while
 * their substance was right — "34 stat rows" written from memory where 17
 * exist. Jarvis already has a numbers rule (`mc-ctl audit-claim`, CLAUDE.md)
 * and the S2/V8.2 critics check numbers post-hoc with an LLM. This is the
 * free deterministic layer under both: every aggregate-looking number in the
 * deliverable is looked up in the run's tool-output corpus (plus the task's
 * own input); numbers found nowhere are reported as UNVERIFIED — a metric in
 * shadow, a footer on the delivered text when `TASK_GATES_NUMBERS_ANNOTATE`
 * is on. It never rewrites a number and never blocks delivery.
 *
 * Corpus: `recordToolEvidence()` is called from `ToolRegistry.execute` with
 * the digest of every tool result of the current run (task id from the
 * run-tool context); `takeToolEvidence()` hands it to the dispatcher at
 * completion and frees it.
 */

const MAX_ITEM_CHARS = 8 * 1024;
const MAX_TASK_CHARS = 256 * 1024;

const evidenceByTask = new Map<string, { chunks: string[]; size: number }>();

export function recordToolEvidence(taskId: string, text: string): void {
  if (!taskId || !text) return;
  const digest =
    text.length > MAX_ITEM_CHARS
      ? `${text.slice(0, MAX_ITEM_CHARS / 2)} … ${text.slice(-MAX_ITEM_CHARS / 2)}`
      : text;
  let entry = evidenceByTask.get(taskId);
  if (!entry) {
    entry = { chunks: [], size: 0 };
    evidenceByTask.set(taskId, entry);
  }
  if (entry.size + digest.length > MAX_TASK_CHARS) return; // cap: keep the earliest evidence
  entry.chunks.push(digest);
  entry.size += digest.length;
}

/** Returns the corpus recorded for the task and forgets it. */
export function takeToolEvidence(taskId: string): string[] {
  const entry = evidenceByTask.get(taskId);
  evidenceByTask.delete(taskId);
  return entry ? entry.chunks : [];
}

/** @internal test hook */
export function _resetToolEvidence(): void {
  evidenceByTask.clear();
}

/**
 * Aggregate-looking numbers: ≥2 digits or carrying a %/$/k/M unit; not part
 * of an identifier (`v8.4`, `G1`, `#12`, `2026-08-16`), a clock time, or a
 * bare 4-digit year.
 */
const NUMBER_RE =
  /(?<![\w.#/:-])(\$?\s?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?(?:%|k|K|M|MM|mil|millones|USD|MXN))?(?![\w/:-]|\.\d)/g;

export interface NumbersAudit {
  /** Every candidate number found in the text (as written). */
  found: string[];
  /** Candidates whose digits appear nowhere in the corpus. */
  unverified: string[];
}

function normalizeDigits(s: string): string {
  return s.replace(/[^0-9.]/g, "").replace(/\.$/, "");
}

export function auditNumbers(
  text: string,
  corpus: readonly string[],
): NumbersAudit {
  const haystack = corpus.join("\n").replace(/,/g, "");
  const found: string[] = [];
  const unverified: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) {
    const [whole, currency, digits, unit] = m;
    const bare = digits.replace(/,/g, "");
    const hasUnit = Boolean(currency?.trim()) || Boolean(unit);
    // Skip small counts without a unit ("3 tareas") and bare years.
    if (!hasUnit && bare.length < 2) continue;
    if (!hasUnit && /^(19|20)\d{2}$/.test(bare)) continue;
    const key = normalizeDigits(whole);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push(whole.trim());
    if (!haystack.includes(key)) unverified.push(whole.trim());
  }
  return { found, unverified };
}

/** Footer appended to a delivered report when annotation is armed. Spanish — product surface. */
export function formatUnverifiedFooter(audit: NumbersAudit): string {
  if (audit.unverified.length === 0) return "";
  const list = audit.unverified.slice(0, 8).join(", ");
  const more =
    audit.unverified.length > 8 ? ` (+${audit.unverified.length - 8})` : "";
  return `\n\n⚠️ Cifras sin respaldo en las herramientas de esta corrida (no verificadas): ${list}${more}`;
}

export function numbersAnnotateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TASK_GATES_NUMBERS_ANNOTATE === "true";
}
