/**
 * V8.4 numbers-provenance audit: aggregate-looking numbers are looked up in
 * the run's tool-output corpus; identifiers, years, times and tiny counts are
 * not candidates; the collector is capped and freed per task.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetToolEvidence,
  auditNumbers,
  formatUnverifiedFooter,
  numbersAnnotateEnabled,
  recordToolEvidence,
  takeToolEvidence,
} from "./numbers.js";

afterEach(() => _resetToolEvidence());

describe("auditNumbers", () => {
  it("verifies numbers present in the corpus (comma-insensitive) and flags the rest", () => {
    const text =
      "Se cargaron 1,741 hallazgos (436 marcas, 98.2% de cobertura) por $12,500 MXN; 34 filas nuevas.";
    const corpus = [
      '{"findings":1741,"marcas":436}',
      "coverage: 98.2%",
      "amount 12500",
    ];
    const audit = auditNumbers(text, corpus);
    expect(audit.found).toEqual(["1,741", "436", "98.2%", "$12,500 MXN", "34"]);
    expect(audit.unverified).toEqual(["34"]);
  });

  it("skips identifiers, versions, dates/times, bare years and single digits without a unit", () => {
    const text =
      "V8.4 shipped 2026-08-16 at 12:01; task #157, commit ec8d9dd, 3 tareas, año 2025, v0.3.1.";
    const audit = auditNumbers(text, []);
    expect(audit.found).toEqual([]);
  });

  it("keeps small numbers when they carry a unit ($, %)", () => {
    const audit = auditNumbers("subió 5% y costó $7", ["5%"]);
    expect(audit.found).toEqual(["5%", "$7"]);
    expect(audit.unverified).toEqual(["$7"]);
  });

  it("dedupes repeated numbers and normalizes units in the lookup", () => {
    const audit = auditNumbers("88 runs; again 88 runs; 21.5% share.", [
      "gmail_send: 88",
      "share=21.5",
    ]);
    expect(audit.found).toEqual(["88", "21.5%"]);
    expect(audit.unverified).toEqual([]);
  });
});

describe("tool-evidence collector", () => {
  it("records per task, digests long items, caps the total, and frees on take", () => {
    recordToolEvidence("t1", "short");
    recordToolEvidence("t1", "x".repeat(20_000));
    recordToolEvidence("t2", "other");
    const t1 = takeToolEvidence("t1");
    expect(t1).toHaveLength(2);
    expect(t1[1]!.length).toBeLessThan(20_000);
    expect(t1[1]).toContain(" … ");
    expect(takeToolEvidence("t1")).toEqual([]); // freed
    expect(takeToolEvidence("t2")).toEqual(["other"]);
    // Cap: 256KB total per task — later items are dropped, earliest kept.
    for (let i = 0; i < 40; i++)
      recordToolEvidence("t3", `${i}:` + "y".repeat(8000));
    const t3 = takeToolEvidence("t3");
    expect(t3.length).toBeLessThan(40);
    expect(t3[0]!.startsWith("0:")).toBe(true);
    recordToolEvidence("", "ignored");
    recordToolEvidence("t4", "");
    expect(takeToolEvidence("t4")).toEqual([]);
  });
});

describe("footer + flag", () => {
  it("formats a Spanish footer capped at 8 items and reads the annotate flag", () => {
    expect(formatUnverifiedFooter({ found: [], unverified: [] })).toBe("");
    const footer = formatUnverifiedFooter({
      found: [],
      unverified: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    });
    expect(footer).toContain("Cifras sin respaldo");
    expect(footer).toContain("1, 2, 3, 4, 5, 6, 7, 8 (+2)");
    expect(numbersAnnotateEnabled({})).toBe(false);
    expect(
      numbersAnnotateEnabled({ TASK_GATES_NUMBERS_ANNOTATE: "true" }),
    ).toBe(true);
  });
});
