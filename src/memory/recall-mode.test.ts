import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { logRecall } from "./recall-utility.js";
import {
  DEFAULT_RECALL_MODE,
  excludeOutcomesForMode,
  resolveExcludeOutcomes,
  resolveRecallMode,
} from "./recall-mode.js";
import type { RecallOptions } from "./types.js";

/** Minimal RecallOptions — `bank` is the only required field. */
function opts(extra: Partial<RecallOptions> = {}): RecallOptions {
  return { bank: "mc-jarvis", ...extra };
}

describe("excludeOutcomesForMode", () => {
  it("coherence drops outcome:failed; the other modes drop nothing", () => {
    expect(excludeOutcomesForMode("coherence")).toEqual(["outcome:failed"]);
    expect(excludeOutcomesForMode("correspondence")).toEqual([]);
    expect(excludeOutcomesForMode("unfiltered")).toEqual([]);
  });
});

describe("resolveExcludeOutcomes — precedence", () => {
  it("defaults to coherence when nothing is set (behaviour-neutral)", () => {
    expect(resolveExcludeOutcomes(opts())).toEqual(["outcome:failed"]);
  });

  it("recallMode drives the exclude set when the legacy knobs are unset", () => {
    expect(resolveExcludeOutcomes(opts({ recallMode: "coherence" }))).toEqual([
      "outcome:failed",
    ]);
    expect(
      resolveExcludeOutcomes(opts({ recallMode: "correspondence" })),
    ).toEqual([]);
    expect(resolveExcludeOutcomes(opts({ recallMode: "unfiltered" }))).toEqual(
      [],
    );
  });

  it("includeFailed wins over recallMode", () => {
    expect(
      resolveExcludeOutcomes(
        opts({ includeFailed: true, recallMode: "coherence" }),
      ),
    ).toEqual([]);
  });

  it("an explicit excludeOutcomes wins over recallMode", () => {
    expect(
      resolveExcludeOutcomes(
        opts({
          excludeOutcomes: ["outcome:concerns"],
          recallMode: "correspondence",
        }),
      ),
    ).toEqual(["outcome:concerns"]);
    // explicit empty list is honoured verbatim
    expect(resolveExcludeOutcomes(opts({ excludeOutcomes: [] }))).toEqual([]);
  });
});

describe("resolveRecallMode — effective mode for the audit tag", () => {
  it("an explicit recallMode is returned verbatim", () => {
    expect(resolveRecallMode(opts({ recallMode: "unfiltered" }))).toBe(
      "unfiltered",
    );
  });

  it("defaults to coherence", () => {
    expect(resolveRecallMode(opts())).toBe(DEFAULT_RECALL_MODE);
    expect(DEFAULT_RECALL_MODE).toBe("coherence");
  });

  it("classifies includeFailed / empty excludeOutcomes as correspondence", () => {
    expect(resolveRecallMode(opts({ includeFailed: true }))).toBe(
      "correspondence",
    );
    expect(resolveRecallMode(opts({ excludeOutcomes: [] }))).toBe(
      "correspondence",
    );
  });

  it("a non-empty custom excludeOutcomes is still a filtered (coherence) recall", () => {
    expect(
      resolveRecallMode(opts({ excludeOutcomes: ["outcome:failed"] })),
    ).toBe("coherence");
  });

  it("mirrors resolveExcludeOutcomes precedence — legacy knobs win the tag too (R1-W1)", () => {
    // includeFailed wins the exclude set ([]), so it must win the tag too.
    expect(
      resolveRecallMode(opts({ includeFailed: true, recallMode: "coherence" })),
    ).toBe("correspondence");
    // A non-empty explicit excludeOutcomes wins the set → the recall IS
    // filtered → tag 'coherence', even though recallMode said 'unfiltered'.
    // (Without the W1 fix this mislabelled a filtered recall as unfiltered.)
    expect(
      resolveRecallMode(
        opts({ excludeOutcomes: ["outcome:failed"], recallMode: "unfiltered" }),
      ),
    ).toBe("coherence");
    // recallMode is honoured only when no legacy knob is set.
    expect(resolveRecallMode(opts({ recallMode: "correspondence" }))).toBe(
      "correspondence",
    );
  });

  it("the logged mode is always consistent with the applied exclude set (R1-W1)", () => {
    // For every input, an empty exclude set ⇒ correspondence/unfiltered tag;
    // a non-empty set ⇒ coherence tag. No mislabels.
    const cases: RecallOptions[] = [
      opts(),
      opts({ recallMode: "coherence" }),
      opts({ recallMode: "correspondence" }),
      opts({ recallMode: "unfiltered" }),
      opts({ includeFailed: true }),
      opts({ excludeOutcomes: [] }),
      opts({ excludeOutcomes: ["outcome:failed"] }),
      opts({ excludeOutcomes: ["outcome:failed"], recallMode: "unfiltered" }),
      opts({ includeFailed: true, recallMode: "coherence" }),
    ];
    for (const c of cases) {
      const filtered = resolveExcludeOutcomes(c).length > 0;
      const mode = resolveRecallMode(c);
      expect(filtered ? mode === "coherence" : mode !== "coherence").toBe(true);
    }
  });
});

describe("recall_audit.mode column", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  afterEach(() => {
    closeDatabase();
  });

  it("logRecall persists the mode", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "test query",
      source: "sqlite-only",
      results: [],
      latencyMs: 12,
      mode: "correspondence",
    });
    const row = getDatabase()
      .prepare("SELECT mode FROM recall_audit ORDER BY id DESC LIMIT 1")
      .get() as { mode: string | null };
    expect(row.mode).toBe("correspondence");
  });

  it("logRecall writes NULL mode when omitted", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "no mode",
      source: "sqlite-only",
      results: [],
      latencyMs: 5,
    });
    const row = getDatabase()
      .prepare("SELECT mode FROM recall_audit ORDER BY id DESC LIMIT 1")
      .get() as { mode: string | null };
    expect(row.mode).toBeNull();
  });

  it("the CHECK constraint rejects an invalid mode value", () => {
    expect(() =>
      getDatabase()
        .prepare(
          "INSERT INTO recall_audit (bank, query, source, mode) VALUES ('b', 'q', 'sqlite-only', 'bogus')",
        )
        .run(),
    ).toThrow();
  });
});
