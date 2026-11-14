/**
 * The pure value check: a value the mailbox tool printed (seen) survives in a
 * reply only when this run proved it. Candidates, bounds, layouts, counts,
 * the one line and its idempotence. Fixtures are synthetic (example.test
 * addresses, obviously fake values without look-alike characters).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PASSWORD_WITHHELD_LINE,
  PASSWORD_WITHHELD_PLACEHOLDER,
  candidateFingerprints,
  candidateRuns,
  cutKeepingWithheldLine,
  hasUnprovenValue,
  passwordFingerprint,
  replaceUnprovenValues,
  withholdUnprovenValues,
  withoutWithheldLine,
  type PasswordValueCheck,
} from "./password-gate.js";
import { isLedgerLine } from "./ledger-lines.js";

const PW = "FakeTestPassWordXYZ2345";
const PW2 = "FakeTestPassWordXYZ6789";
const STALE = "PriorTestPassWordQRS2345";
const BOX = "box@example.test";

function check(seen: string[], proven: string[] = []): PasswordValueCheck {
  const s = new Set(seen.map(passwordFingerprint));
  const p = new Set(proven.map(passwordFingerprint));
  return { isSeen: (fp) => s.has(fp), isProven: (fp) => p.has(fp) };
}

const A = (n: number) => "Ab3".repeat(30).slice(0, n);

// CPU-time measurement. Process CPU time, not elapsed time: a fixed bound on elapsed time fails
// on a busy machine although nothing is wrong, while CPU time leaves out the time spent waiting
// for a processor.

/** CPU ms per call of `fn`: one warm-up call, then the minimum of 3 runs of `reps` calls each. */
function cpuMsPerCall(fn: () => unknown, reps = 1): number {
  fn();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn();
    const d = process.cpuUsage(c0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best / reps;
}

/** Bound on `growth4x().ratio`: linear work measures about 4, quadratic work about 16. */
const GROWTH_BOUND = 8;

/**
 * How the CPU time of `fn` grows from input `make(n)` to input `make(4 * n)`. Both sizes repeat
 * the call the same number of times, doubled until one run of the smaller size takes 40 ms, so
 * the figure is not lost in timer noise. Linear work grows about 4x and quadratic work about 16x,
 * whatever the machine's speed or load. The ratio is measured up to three times and the smallest
 * is kept, stopping at the first one under GROWTH_BOUND: on a busy machine one noisy measurement
 * can push a single ratio over the bound, but the noise does not repeat three times, while a real
 * super-linear change measures about 16x on every attempt and still fails. `largeMs` is the larger
 * size's CPU ms per call from the first attempt.
 */
function growth4x<T>(
  make: (size: number) => T,
  n: number,
  fn: (input: T) => unknown,
): { ratio: number; largeMs: number; label: string } {
  const small = make(n);
  const large = make(4 * n);
  let reps = 1;
  fn(small);
  for (;;) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn(small);
    const d = process.cpuUsage(c0);
    if ((d.user + d.system) / 1000 >= 40 || reps >= 1_000_000) break;
    reps *= 2;
  }
  let ratio = Infinity;
  let largeMs = NaN;
  let label = "";
  for (let attempt = 1; attempt <= 3 && ratio >= GROWTH_BOUND; attempt++) {
    const a = cpuMsPerCall(() => fn(small), reps);
    const b = cpuMsPerCall(() => fn(large), reps);
    if (attempt === 1) largeMs = b;
    if (b / a < ratio) {
      ratio = b / a;
      label = `${b.toFixed(3)} ms / ${a.toFixed(3)} ms per call, ${reps} calls per run, attempt ${attempt}`;
    }
  }
  return { ratio, largeMs, label };
}

describe("password gate — candidates", () => {
  it("are maximal ASCII letter/digit runs of 16 to 64: 15 and 65 are not", () => {
    const text = `${A(15)} ${A(16)} ${A(64)} ${A(65)}`;
    expect(
      candidateRuns(text).map((r) => r.end - r.start),
    ).toEqual([16, 64]);
  });

  it("a seen value inside a longer letter/digit run is not touched", () => {
    const longer = `${PW}x${"Q".repeat(50)}`;
    const text = `token ${longer} y ${STALE}x`;
    expect(replaceUnprovenValues(text, check([PW, STALE]))).toEqual({
      text,
      checked: 0,
      withheld: 0,
    });
  });

  it("a scan from an offset walks back to the start of the run it cuts", () => {
    const text = `hola ${STALE} fin`;
    const at = text.indexOf(STALE) + 5;
    expect(candidateRuns(text, at)).toEqual([
      { start: text.indexOf(STALE), end: text.indexOf(STALE) + STALE.length },
    ]);
  });

  it("a scan from an offset inside a run longer than 64 skips that run", () => {
    const text = `${"Q".repeat(100)} ${PW}`;
    expect(candidateRuns(text, 80)).toEqual([
      { start: 101, end: 101 + PW.length },
    ]);
  });

  it("a scan from the end of a 65-character run walks back over all of it", () => {
    const value = "Ab3".repeat(21) + "A"; // 64 characters
    expect(candidateRuns("Z" + value + " ", 65)).toEqual([]);
  });

  it("the fingerprint is a prefixed sha256 hex, not the plain hash, never the value", () => {
    const fp = passwordFingerprint(PW);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain(PW);
    expect(fp).not.toBe(createHash("sha256").update(PW).digest("hex"));
    expect(candidateFingerprints(`ponle ${PW}, ya`)).toEqual([fp]);
  });

  it("the placeholder and the line hold no candidate, and the line is a ledger line", () => {
    expect(candidateRuns(PASSWORD_WITHHELD_PLACEHOLDER)).toEqual([]);
    expect(candidateRuns(PASSWORD_WITHHELD_LINE)).toEqual([]);
    expect(isLedgerLine(PASSWORD_WITHHELD_LINE)).toBe(true);
  });
});

describe("password gate — a run right after a backslash", () => {
  const BS = "\\";

  it("also yields the run without its first character: at most one extra candidate", () => {
    const text = `clave:${BS}n${STALE} fin`;
    const at = text.indexOf(STALE);
    expect(candidateRuns(text)).toEqual([
      { start: at - 1, end: at + STALE.length },
      { start: at, end: at + STALE.length },
    ]);
    expect(candidateFingerprints(text)).toContain(passwordFingerprint(STALE));
  });

  it.each([
    ["\\n", `clave:${BS}n${STALE}`],
    ["\\t", `clave:${BS}t${STALE}`],
    ["\\r", `clave:${BS}r${STALE}`],
    ["a doubly encoded \\n", `clave:${BS}${BS}n${STALE}`],
    ["a quoted field", `{"answer":"clave:${BS}n${STALE}"}`],
  ])("a seen value after %s is withheld and the escape stays", (_name, text) => {
    const res = replaceUnprovenValues(text, check([STALE]));
    expect(res).toEqual({
      text: text.replace(STALE, PASSWORD_WITHHELD_PLACEHOLDER),
      checked: 1,
      withheld: 1,
    });
    expect(hasUnprovenValue(text, check([STALE]))).toBe(true);
  });

  it("the full run wins when it is the seen value; the shorter one is not looked at", () => {
    const text = `x${BS}${STALE}`;
    expect(replaceUnprovenValues(text, check([STALE, STALE.slice(1)]))).toEqual({
      text: `x${BS}${PASSWORD_WITHHELD_PLACEHOLDER}`,
      checked: 1,
      withheld: 1,
    });
    // The full run proven: the stream hold and the final check agree it passes.
    const proven = check([STALE, STALE.slice(1)], [STALE]);
    expect(replaceUnprovenValues(text, proven)).toEqual({ text, checked: 1, withheld: 0 });
    expect(hasUnprovenValue(text, proven)).toBe(false);
  });

  it("lengths: 17 → the 16 after the letter counts; 16 → only the full run; 65 → the 64 after the letter counts", () => {
    const lens = (text: string) => candidateRuns(text).map((r) => r.end - r.start);
    expect(lens(`${BS}${A(17)}`)).toEqual([17, 16]);
    expect(lens(`${BS}${A(16)}`)).toEqual([16]);
    expect(lens(`${BS}${A(65)}`)).toEqual([64]);
    expect(lens(`${BS}${A(66)}`)).toEqual([]);
    expect(lens(`-${A(17)}`)).toEqual([17]);
  });

  it("a scan from an offset inside the run still sees the backslash before it", () => {
    const text = `clave:${BS}n${STALE}`;
    expect(hasUnprovenValue(text, check([STALE]), text.length - 3)).toBe(true);
    const long = `${BS}n${A(64)}`; // 65 after the backslash: only the 64 counts
    expect(candidateRuns(long, long.length).map((r) => r.end - r.start)).toEqual([64]);
  });

  it("stays linear: 20,000 escaped candidates", () => {
    const text = `${BS}n${STALE} `.repeat(20_000);
    expect(replaceUnprovenValues(text, check([STALE])).withheld).toBe(20_000);
    // 1,000 to 4,000 candidates: about 4x for linear work, 16x for quadratic (both texts under
    // 128 KB, where the growth measures closer to linear); the original 2 s ceiling at 20,000.
    const g = growth4x((n) => `${BS}n${STALE} `.repeat(n), 1_000, (t) => replaceUnprovenValues(t, check([STALE])));
    expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
    expect(cpuMsPerCall(() => replaceUnprovenValues(text, check([STALE])))).toBeLessThan(2000);
  });
});

describe("password gate — a run right after a \\uXXXX escape", () => {
  const BS = "\\";
  const lens = (text: string, from = 0) =>
    candidateRuns(text, from).map((r) => r.end - r.start);

  it("also yields the run without its first five characters: the full run, minus one, minus five", () => {
    const text = `clave:${BS}u00e9${STALE}`;
    const at = text.indexOf(STALE);
    expect(candidateRuns(text)).toEqual([
      { start: at - 5, end: at + STALE.length },
      { start: at - 4, end: at + STALE.length },
      { start: at, end: at + STALE.length },
    ]);
    expect(candidateFingerprints(text)).toContain(passwordFingerprint(STALE));
  });

  it.each([
    ["a lowercase escape", `clave:${BS}u00e9${STALE}`],
    ["an uppercase hex escape", `clave:${BS}uDC00${STALE}`],
    ["a control character escape", `{"data":"${BS}u0001${STALE}"}`],
  ])("%s: the seen value is withheld and the escape stays", (_name, text) => {
    expect(replaceUnprovenValues(text, check([STALE]))).toEqual({
      text: text.replace(STALE, PASSWORD_WITHHELD_PLACEHOLDER),
      checked: 1,
      withheld: 1,
    });
    expect(hasUnprovenValue(text, check([STALE]))).toBe(true);
  });

  it("lengths: minus five counts when 16–64; four hex digits and a lowercase u are required", () => {
    expect(lens(`${BS}u00e9${A(16)}`)).toEqual([21, 20, 16]);
    expect(lens(`${BS}u00e9${A(15)}`)).toEqual([20, 19]);
    expect(lens(`${BS}u00e9${A(64)}`)).toEqual([64]);
    expect(lens(`${BS}u00e9${A(65)}`)).toEqual([]);
    expect(lens(`${BS}u00g9${A(16)}`)).toEqual([21, 20]);
    expect(lens(`${BS}U00e9${A(16)}`)).toEqual([21, 20]);
    expect(lens(`-u00e9${A(16)}`)).toEqual([21]);
  });

  it("the first seen candidate decides: a proven longer reading hides the shorter ones", () => {
    const text = `x${BS}u00e9${STALE}`;
    const minusOne = `00e9${STALE}`;
    const proven = check([minusOne, STALE], [minusOne]);
    expect(replaceUnprovenValues(text, proven)).toEqual({ text, checked: 1, withheld: 0 });
    expect(hasUnprovenValue(text, proven)).toBe(false);
    expect(replaceUnprovenValues(text, check([minusOne, STALE]))).toEqual({
      text: `x${BS}u${PASSWORD_WITHHELD_PLACEHOLDER}`,
      checked: 1,
      withheld: 1,
    });
  });

  it.each([
    ["a 24-character value", STALE],
    ["a 64-character value", A(64)],
  ])("%s: the stream and the final check agree at every split point", (_name, value) => {
    const text = `clave: ${BS}u00e9${value}`;
    const c = check([value]);
    expect(replaceUnprovenValues(text, c).withheld).toBe(1);
    for (let k = 0; k <= text.length; k++) {
      const held =
        hasUnprovenValue(text.slice(0, k), c) || hasUnprovenValue(text, c, k);
      expect(held, `split at ${k}`).toBe(true);
    }
    expect(lens(text, text.length)).toContain(value.length);
  });

  it("a scan from an offset inside a run of 70 or more skips it", () => {
    const text = `${BS}u00e9${A(65)}`;
    expect(lens(text, text.length)).toEqual([]);
  });

  it("stays linear: 20,000 \\uXXXX-escaped candidates", () => {
    const text = `${BS}u00e9${STALE} `.repeat(20_000);
    expect(replaceUnprovenValues(text, check([STALE])).withheld).toBe(20_000);
    // 1,000 to 4,000 candidates: about 4x for linear work, 16x for quadratic (both texts under
    // 128 KB, where the growth measures closer to linear); the original 3 s ceiling at 20,000.
    const g = growth4x((n) => `${BS}u00e9${STALE} `.repeat(n), 1_000, (t) =>
      replaceUnprovenValues(t, check([STALE])),
    );
    expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
    expect(cpuMsPerCall(() => replaceUnprovenValues(text, check([STALE])))).toBeLessThan(3000);
  });
});

describe("password gate — the check", () => {
  it("a seen value with no proof is withheld in every layout; the wording around it does not matter", () => {
    const layouts = [
      `Buzón ${BOX}, contraseña: \`${STALE}\``,
      `| buzón | contraseña |\n|---|---|\n| ${BOX} | ${STALE} |`,
      `La contraseña:\n\`\`\`\n${STALE}\n\`\`\``,
      `**${STALE}** es la clave de ${BOX}`,
      `<code>${STALE}</code>`,
      `${STALE}`,
      `usa "${STALE}".`,
    ];
    for (const text of layouts) {
      const res = withholdUnprovenValues(text, check([STALE]));
      expect(res.checked).toBe(1);
      expect(res.withheld).toBe(1);
      expect(res.text).not.toContain(STALE);
      expect(res.text).toContain(PASSWORD_WITHHELD_PLACEHOLDER);
      expect(res.text.endsWith(`\n\n${PASSWORD_WITHHELD_LINE}`)).toBe(true);
    }
  });

  it("a proven value passes untouched; a value never seen is never touched", () => {
    const text = `${BOX}: \`${PW}\`; folio ABCDEFGH23456789XYZ; id 4f3c2b1a9e8d7c6b5a4f3e2d`;
    expect(withholdUnprovenValues(text, check([PW], [PW]))).toEqual({
      text,
      checked: 1,
      withheld: 0,
    });
    expect(withholdUnprovenValues(text, check([]))).toEqual({
      text,
      checked: 0,
      withheld: 0,
    });
  });

  it("two values, one proven: checked 2, withheld 1, every occurrence of the stale one replaced", () => {
    const text = `nueva: ${PW}\nanterior: ${STALE} (repito: ${STALE})`;
    const res = withholdUnprovenValues(text, check([PW, STALE], [PW]));
    expect(res.checked).toBe(3);
    expect(res.withheld).toBe(2);
    expect(res.text).toBe(
      `nueva: ${PW}\nanterior: ${PASSWORD_WITHHELD_PLACEHOLDER} (repito: ${PASSWORD_WITHHELD_PLACEHOLDER})\n\n${PASSWORD_WITHHELD_LINE}`,
    );
  });

  it("exactly one line when the text already carries it and a new value is withheld", () => {
    const text = `ya: ${PASSWORD_WITHHELD_PLACEHOLDER}\n\n${PASSWORD_WITHHELD_LINE}\notra: ${PW2}`;
    const res = withholdUnprovenValues(text, check([PW2]));
    expect(res.withheld).toBe(1);
    expect(res.text.split(PASSWORD_WITHHELD_LINE)).toHaveLength(2);
    expect(res.text).not.toContain(PW2);
  });

  it("a text that already holds the placeholder and nothing to withhold gets the line once", () => {
    // A stored text keeps only the placeholder; a reply that repeats it
    // carries the explanation too.
    const text = `${BOX}: ${PASSWORD_WITHHELD_PLACEHOLDER}`;
    expect(withholdUnprovenValues(text, check([]))).toEqual({
      text: `${text}\n\n${PASSWORD_WITHHELD_LINE}`,
      checked: 0,
      withheld: 0,
    });
    const once = `${text}\n\n${PASSWORD_WITHHELD_LINE}`;
    expect(withholdUnprovenValues(once, check([])).text).toBe(once);
  });

  it("a text that carries the line in the middle is left as it is: present anywhere counts", () => {
    const middle = `${BOX}: ${PASSWORD_WITHHELD_PLACEHOLDER}\n\n${PASSWORD_WITHHELD_LINE}\n\nOtro párrafo.`;
    expect(withholdUnprovenValues(middle, check([])).text).toBe(middle);
  });

  it("is idempotent: a second pass over its own output changes nothing", () => {
    const first = withholdUnprovenValues(`${BOX} ${STALE}`, check([STALE]));
    const second = withholdUnprovenValues(first.text, check([STALE]));
    expect(second).toEqual({ text: first.text, checked: 0, withheld: 0 });
  });

  it("asks the seen store only for candidates, once each, and stays fast on a long text", () => {
    let asked = 0;
    const counting: PasswordValueCheck = {
      isSeen: () => {
        asked++;
        return false;
      },
      isProven: () => false,
    };
    const piece = `a@b.c ${A(20)} | x | \`y\` ${"z".repeat(70)} `;
    const text = piece.repeat(20_000);
    const res = replaceUnprovenValues(text, counting);
    expect(res.text).toBe(text);
    expect(asked).toBe(20_000);
    // 250 to 1,000 pieces: about 4x for linear work, 16x for quadratic (both texts under
    // 128 KB, where the growth measures closer to linear); the original 2 s ceiling at 20,000.
    const g = growth4x((n) => piece.repeat(n), 250, (t) => replaceUnprovenValues(t, counting));
    expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
    expect(cpuMsPerCall(() => replaceUnprovenValues(text, counting))).toBeLessThan(2000);
  });

  it("hasUnprovenValue: true for a seen-and-unproven value from the offset on, false once proven", () => {
    const text = `hola ${STALE}`;
    expect(hasUnprovenValue(text, check([STALE]))).toBe(true);
    expect(hasUnprovenValue(text, check([STALE], [STALE]))).toBe(false);
    expect(hasUnprovenValue(text, check([STALE]), text.length)).toBe(true);
    expect(hasUnprovenValue(`${text} y más texto`, check([STALE]), text.length + 3)).toBe(false);
  });
});

// A cut after the check (word cap, length limit) runs on the text without
// the line; a kept placeholder gets the full line back once, at the end.
describe("cutKeepingWithheldLine", () => {
  const P = PASSWORD_WITHHELD_PLACEHOLDER;
  const L = PASSWORD_WITHHELD_LINE;
  const head = (n: number) => (t: string, room: number) =>
    t.length > n - room ? t.slice(0, n - room) : t;

  it("a text without the placeholder goes to the cut as it is, with no room taken", () => {
    const seen: [string, number][] = [];
    const out = cutKeepingWithheldLine("abc def", (t, room) => {
      seen.push([t, room]);
      return t.slice(0, 3);
    });
    expect(out).toBe("abc");
    expect(seen).toEqual([["abc def", 0]]);
  });

  it("the cut sees the text without the line and the line's length as room", () => {
    const seen: [string, number][] = [];
    cutKeepingWithheldLine(`a ${P} b\n\n${L}`, (t, room) => {
      seen.push([t, room]);
      return t;
    });
    expect(seen).toEqual([[`a ${P} b`, L.length + 2]]);
  });

  it("a text the cut leaves whole comes back as it was (line in the middle included)", () => {
    const text = `a ${P}\n\n${L}\n\nGates: 1/1 met`;
    expect(cutKeepingWithheldLine(text, (t) => t)).toBe(text);
  });

  it("kept placeholder → the full line once at the end, inside the limit", () => {
    const out = cutKeepingWithheldLine(`a ${P} ${"x".repeat(500)}\n\n${L}`, head(300));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith(`a ${P} x`)).toBe(true);
    expect(out.endsWith(`\n\n${L}`)).toBe(true);
    expect(out.split(L)).toHaveLength(2);
  });

  it("a limit that falls inside the line delivers one full line, not half of it", () => {
    const body = `a ${P} ${"x".repeat(200)}`;
    const text = `${body}\n\n${L}`;
    const limit = body.length + 2 + Math.floor(L.length / 2);
    expect(text.slice(0, limit).endsWith(L)).toBe(false); // a plain cut halves it
    const out = cutKeepingWithheldLine(text, head(limit));
    expect(out.length).toBeLessThanOrEqual(limit);
    expect(out.endsWith(`\n\n${L}`)).toBe(true);
    expect(out.split(L)).toHaveLength(2);
  });

  it("placeholder cut away → no line", () => {
    const out = cutKeepingWithheldLine(`${"x".repeat(100)} ${P}\n\n${L}`, (t) => t.slice(0, 50));
    expect(out).toBe("x".repeat(50));
  });

  it("two copies of the line come back as one", () => {
    const out = cutKeepingWithheldLine(`a ${P}\n\n${L}\n\n${L} ${"x".repeat(50)}`, (t) => t.slice(0, 2 + P.length));
    expect(out.split(L)).toHaveLength(2);
    expect(out.endsWith(L)).toBe(true);
  });

  it("withoutWithheldLine drops every copy and returns a text without one unchanged", () => {
    expect(withoutWithheldLine(`a\n\n${L}`)).toBe("a");
    expect(withoutWithheldLine(`${L}\nb\n\n${L}`)).toBe("\nb");
    const plain = `a ${P} b`;
    expect(withoutWithheldLine(plain)).toBe(plain);
  });
});
