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
  hasUnprovenValue,
  passwordFingerprint,
  replaceUnprovenValues,
  withholdUnprovenValues,
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
    const t0 = Date.now();
    const res = replaceUnprovenValues(text, counting);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.text).toBe(text);
    expect(asked).toBe(20_000);
  });

  it("hasUnprovenValue: true for a seen-and-unproven value from the offset on, false once proven", () => {
    const text = `hola ${STALE}`;
    expect(hasUnprovenValue(text, check([STALE]))).toBe(true);
    expect(hasUnprovenValue(text, check([STALE], [STALE]))).toBe(false);
    expect(hasUnprovenValue(text, check([STALE]), text.length)).toBe(true);
    expect(hasUnprovenValue(`${text} y más texto`, check([STALE]), text.length + 3)).toBe(false);
  });
});
