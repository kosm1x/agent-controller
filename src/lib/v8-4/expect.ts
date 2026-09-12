/**
 * The `expect` grammar of a Honest-Done gate, and the write-time refusal of an
 * expectation that cannot fail.
 *
 * Before 2026-09-12 `expect` was a free substring or `/regex/`, and the planner
 * wrote digit-class regexes — `/[0-9]/` on `grep -c …` is satisfied by the
 * failure output `0`; `/[1-9]/`, `/[3-9]/`, `/[4-9]|1[0-9]/` match a stray
 * digit in an error line and cannot name the number they mean. 34 of the 61
 * predicate-bearing gates of the previous 30 days used that family and five
 * were recorded MET in enforce mode. Shape adopted from
 * YOINK (DefiLeoo/YOINK): a claim that cannot be graded is refused the moment
 * it is written, and the refusal names the rule and the fix.
 *
 * Grammar (allow-by-membership, unknown ⇒ refused):
 *
 *   gte N · gt N · lte N · lt N · eq N · neq N · between A B
 *       compared against the LAST non-empty line of the check output, which
 *       must be a bare number — anything else FAILS the gate with evidence.
 *   /regex/flags      must name at least one literal character that is not a
 *                     digit (`/[0-9a-f]{7}/`, `/Avg Δ/` yes; `/[0-9]/`,
 *                     `/\d+/`, `/^200$/` no — use a comparator).
 *   any other text    substring, unchanged.
 *
 * Every regex/substring expectation is also tried against the canonical failure
 * outputs (`""`, `"0\n"`…) at write time; one that matches is refused. A
 * comparator that 0 and any large count both satisfy is refused the same way.
 */

import vm from "node:vm";

export type ComparatorOp = "gte" | "gt" | "lte" | "lt" | "eq" | "neq";

export type ParsedExpect =
  | { kind: "cmp"; op: ComparatorOp; value: number }
  | { kind: "between"; lo: number; hi: number }
  | { kind: "regex"; pattern: string; flags: string }
  | { kind: "substring"; text: string };

const NUM = String.raw`[+-]?\d+(?:\.\d+)?`;
const CMP_RE = new RegExp(`^(gte|gt|lte|lt|eq|neq)\\s+(${NUM})$`, "i");
const BETWEEN_RE = new RegExp(`^between\\s+(${NUM})\\s+(${NUM})$`, "i");
// `gte5` / `gt0` (no space) are comparator attempts too, not substrings (qa W4).
const CMP_WORD_RE = /^(?:gte|gt|lte|lt|eq|neq|between)(?=\s|\d|$)/i;
const REGEX_RE = /^\/(.+)\/([a-z]*)$/;
/** Looks like a regex once trimmed / with bad flags — never silently a substring (qa W3). */
const REGEX_LOOKALIKE_RE = /^\/.+\/[A-Za-z]*$/;
const BARE_NUMBER_RE = new RegExp(`^${NUM}$`);

export const EXPECT_GRAMMAR =
  "gte 10, lte 3.5, gt 0, eq 1, neq 1, between 2 4 (the check prints the number as its LAST line — `wc -l < f`, not `wc -l f`), a substring, or a /regex/ that names a word";

const NESTED_QUANTIFIER_RE = /\([^)]*[+*}][^)]*\)\s*[+*{]|[+*]\s*[+*]/;
const REGEX_DEADLINE_MS = 250;

/**
 * Regex test with a hard deadline: compiled and executed inside a fresh vm
 * context whose `timeout` terminates a runaway match. Any throw — bad
 * pattern, timeout — is a non-match, never a hang. Shared by the check runner
 * and the write-time probe (qa W5: the probe used a bare RegExp before).
 */
export function safeRegexTest(
  pattern: string,
  flags: string,
  haystack: string,
): boolean {
  if (NESTED_QUANTIFIER_RE.test(pattern)) return false;
  try {
    const result: unknown = vm.runInNewContext(
      "new RegExp(pattern, flags).test(haystack)",
      { pattern, flags, haystack },
      { timeout: REGEX_DEADLINE_MS },
    );
    return result === true;
  } catch {
    return false;
  }
}

export function parseExpect(expect: string): ParsedExpect {
  const s = expect.trim();
  const cmp = CMP_RE.exec(s);
  if (cmp) {
    return { kind: "cmp", op: cmp[1]!.toLowerCase() as ComparatorOp, value: Number(cmp[2]) };
  }
  const bt = BETWEEN_RE.exec(s);
  if (bt) return { kind: "between", lo: Number(bt[1]), hi: Number(bt[2]) };
  // Regex and substring match on the RAW text — the pre-grammar behaviour of
  // every existing ledger row, byte for byte.
  const rx = REGEX_RE.exec(expect);
  if (rx) return { kind: "regex", pattern: rx[1]!, flags: rx[2]! };
  return { kind: "substring", text: expect };
}

export function isComparatorExpect(expect: string): boolean {
  const k = parseExpect(expect).kind;
  return k === "cmp" || k === "between";
}

/** The last non-empty line of a check's output as a number, or null when it is not a bare number. */
export function lastNumber(output: string): number | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined || !BARE_NUMBER_RE.test(last)) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

export function compareNumber(
  parsed: Extract<ParsedExpect, { kind: "cmp" | "between" }>,
  n: number,
): boolean {
  if (parsed.kind === "between") return n >= parsed.lo && n <= parsed.hi;
  switch (parsed.op) {
    case "gte":
      return n >= parsed.value;
    case "gt":
      return n > parsed.value;
    case "lte":
      return n <= parsed.value;
    case "lt":
      return n < parsed.value;
    case "eq":
      return n === parsed.value;
    case "neq":
      return n !== parsed.value;
  }
}

/**
 * True when the pattern names at least one literal character that is not a
 * digit. Digit-only classes, `\d`, anchors, groups, alternation, quantifiers,
 * `.` and whitespace classes are not literals — a pattern made only of those
 * is satisfied by any count.
 */
export function regexNamesALiteral(pattern: string): boolean {
  const stripped = pattern
    // group prefixes are syntax, not literals: (?: (?= (?! (?<= (?<! (?<name>   (qa C1)
    .replace(/\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/g, "")
    // digit-only classes, negated or not, incl. escape-only ones like [\s] [^\d]   (qa C2)
    .replace(/\[\^?(?:\d|-|\\[dDsSwWbBnrt]|\s)*\]/g, "")
    .replace(/\\[dDbBsSwWnrt]/g, "")
    .replace(/\{\d*(?:,\d*)?\}/g, "")
    .replace(/[\^$()|*+?.\d\s]/g, "");
  return stripped.length > 0;
}

/** What the check runner actually hands over on failure: the shell's `0` ends in a newline. */
const FAILURE_OUTPUTS = ["", "0", "0\n", "\n", " 0\n", "0\r\n"] as const;

/**
 * The reason an expectation can never grade the gate, or null when it can.
 * Empty text is the caller's business (an absent expect means "exit code
 * decides" everywhere); pass only a non-blank expect.
 */
export function isUnsettleableExpect(expect: string): string | null {
  const s = expect.trim();
  if (CMP_WORD_RE.test(s) && !CMP_RE.test(s) && !BETWEEN_RE.test(s)) {
    return `'${s}' is not a test. Use ${EXPECT_GRAMMAR}`;
  }
  const parsed = parseExpect(expect);
  if (parsed.kind === "substring" && REGEX_LOOKALIKE_RE.test(s)) {
    return `'${s}' looks like a /regex/ but has surrounding whitespace or non-lowercase flags — it would be matched as plain text and never pass`;
  }
  if (parsed.kind === "cmp" || parsed.kind === "between") {
    if (parsed.kind === "between" && parsed.lo > parsed.hi) {
      return `'${s}' is an empty range — the low bound must not exceed the high bound`;
    }
    // A comparator that both the failure count 0 and any large count satisfy
    // (gte 0, gt -1, neq -1) cannot fail on the count axis (qa R2 W1).
    if (compareNumber(parsed, 0) && compareNumber(parsed, Number.MAX_SAFE_INTEGER)) {
      return `'${s}' is satisfied by 0 and by any count — it cannot fail; use gt 0, gte N or eq N`;
    }
    return null;
  }

  let test: (haystack: string) => boolean;
  if (parsed.kind === "regex") {
    try {
      new RegExp(parsed.pattern, parsed.flags);
    } catch (err) {
      return `'${s}' is not a valid /regex/: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (NESTED_QUANTIFIER_RE.test(parsed.pattern)) {
      return `'${s}' has nested quantifiers — the check runner refuses to evaluate it, so the gate could never pass`;
    }
    if (!regexNamesALiteral(parsed.pattern)) {
      return `expect ${s} names only digits — it grades a stray digit in noise as a count (the 1 in "sh: 1: not found") and cannot say which number is right; use a comparator (gt 0, gte N, eq 200) or a /regex/ that names a word`;
    }
    const { pattern, flags } = parsed;
    test = (h) => safeRegexTest(pattern, flags, h);
  } else {
    const text = parsed.text;
    test = (h) => h.includes(text);
  }
  for (const failure of FAILURE_OUTPUTS) {
    if (test(failure)) {
      return `expect ${JSON.stringify(expect)} is satisfied by the failure output ${JSON.stringify(failure)} — use a comparator (gt 0, gte N, eq 0) or name a word`;
    }
  }
  return null;
}
