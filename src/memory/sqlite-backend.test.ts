/**
 * SqliteMemoryBackend recall-instrumentation tests (V8.1 Phase A —
 * bundle V8.1-PA-recall-logging).
 *
 * Scope: the `instrument` constructor flag and the `recall()` wrapper that
 * applies outcome bias + writes a recall_audit row when this backend is the
 * top-level memory service. The hybrid retrieval body (`recallHybrid`) and
 * the collaborators (`applyOutcomeBias`, `logRecall`) are covered by their
 * own suites — here we mock them and verify the wiring only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// getDatabase throws → recallHybrid's outer try/catch returns [] — a
// deterministic empty `raw` so the wrapper assertions don't depend on DB
// state. writeWithRetry is imported by the module but unused on this path.
vi.mock("../db/index.js", () => ({
  getDatabase: vi.fn(() => {
    throw new Error("no db in test");
  }),
  writeWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

const logRecallSpy = vi.fn();
vi.mock("./recall-utility.js", () => ({
  logRecall: (...args: unknown[]) => logRecallSpy(...args),
}));

const applyOutcomeBiasSpy = vi.fn();
vi.mock("./outcome-bias.js", () => ({
  applyOutcomeBias: (...args: unknown[]) => applyOutcomeBiasSpy(...args),
}));

// Ruling 3c fold F7: one synthetic stored value stands in for the secret
// store; embed is stubbed so retain never reaches a provider.
const SCRUB_SYN = vi.hoisted(() => "syn-" + "m".repeat(14));
vi.mock("../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secret-refs.js")>()),
  scrubSecrets: (t: string) => t.replaceAll(SCRUB_SYN, "[oculto]"),
}));
const embedSpy = vi.fn(async () => null);
vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  embed: (...a: unknown[]) => embedSpy(...a),
}));

import { SqliteMemoryBackend } from "./sqlite-backend.js";
import { getDatabase } from "../db/index.js";
import type { MemoryItem, RecallOptions } from "./types.js";

const KEPT: MemoryItem[] = [{ content: "biased-result", tags: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  // Controlled bias result so we can prove the wrapper forwards `kept`,
  // `excluded`, and `breakdown` rather than the raw retrieval output.
  applyOutcomeBiasSpy.mockReturnValue({
    kept: KEPT,
    excluded: 2,
    breakdown: { success: 1, concerns: 0, failed: 2, unknown: 0 },
  });
});

const opts = (extra: Partial<RecallOptions> = {}): RecallOptions =>
  ({ bank: "mc-jarvis", ...extra }) as RecallOptions;

describe("SqliteMemoryBackend — recall instrumentation", () => {
  describe("instrument=true (primary service, the default)", () => {
    it("applies outcome bias to the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(applyOutcomeBiasSpy).toHaveBeenCalledTimes(1);
      // raw is [] because getDatabase throws inside recallHybrid.
      const [rawArg, optsArg] = applyOutcomeBiasSpy.mock.calls[0]!;
      expect(rawArg).toEqual([]);
      expect(optsArg).toMatchObject({ bank: "mc-jarvis" });
    });

    it("writes a recall_audit row tagged source='sqlite-primary'", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(logRecallSpy).toHaveBeenCalledTimes(1);
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.source).toBe("sqlite-primary");
      expect(row.bank).toBe("mc-jarvis");
      expect(row.query).toBe("query text");
      expect(row.results).toBe(KEPT);
      expect(row.excludedCount).toBe(2);
      expect(row.outcomeBreakdown).toEqual({
        success: 1,
        concerns: 0,
        failed: 2,
        unknown: 0,
      });
      expect(typeof row.latencyMs).toBe("number");
      expect(row.latencyMs as number).toBeGreaterThanOrEqual(0);
    });

    it("returns the biased `kept` set, not the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      const result = await backend.recall("query text", opts());
      expect(result).toBe(KEPT);
    });

    it("tags the row with the resolved recall mode (default: coherence)", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts());
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("coherence");
    });

    it("propagates an explicit recallMode onto the logged row", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts({ recallMode: "correspondence" }));
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("correspondence");
    });
  });

  describe("instrument=false (nested fallback / A/B tool)", () => {
    it("does NOT write a recall_audit row", async () => {
      const backend = new SqliteMemoryBackend(false);
      await backend.recall("query text", opts());
      expect(logRecallSpy).not.toHaveBeenCalled();
    });

    it("does NOT apply outcome bias — returns raw retrieval", async () => {
      const backend = new SqliteMemoryBackend(false);
      const result = await backend.recall("query text", opts());
      expect(applyOutcomeBiasSpy).not.toHaveBeenCalled();
      // raw recallHybrid output (getDatabase threw → []).
      expect(result).toEqual([]);
    });
  });
});

describe("SqliteMemoryBackend — retain (ruling 3c)", () => {
  it("stores and embeds the content with stored credential values scrubbed", async () => {
    const run = vi.fn(() => ({ lastInsertRowid: 1 }));
    vi.mocked(getDatabase).mockReturnValueOnce({
      prepare: () => ({ run }),
    } as unknown as ReturnType<typeof getDatabase>);
    await new SqliteMemoryBackend().retain(`Usuario: la clave es ${SCRUB_SYN}`, {
      bank: "mc-jarvis",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toContain("Usuario: la clave es [oculto]");
    expect(JSON.stringify(run.mock.calls)).not.toContain(SCRUB_SYN);
    expect(embedSpy).toHaveBeenCalledWith("Usuario: la clave es [oculto]");
  });
});

describe("SqliteMemoryBackend — recall scrub (ruling 3c, audit R3 B1)", () => {
  // A row stored before the write-side scrub (or before the value was saved)
  // comes back from every retrieval layer; FTS hit here, embed stubbed null.
  const row = () => ({
    content: `Usuario: la clave es ${SCRUB_SYN}`,
    created_at: "2026-01-01 00:00:00",
    trust_tier: 2,
    tags: "[]",
    score: -1,
  });
  const fakeDb = () =>
    ({
      prepare: () => ({ all: () => [row()] }),
    }) as unknown as ReturnType<typeof getDatabase>;

  it.each([
    ["instrument=false (the Hindsight fallback)", false],
    ["instrument=true (primary service)", true],
  ])("%s: recalled content carries no stored value", async (_l, instrument) => {
    applyOutcomeBiasSpy.mockImplementation((raw: MemoryItem[]) => ({
      kept: raw,
      excluded: 0,
      breakdown: { success: 0, concerns: 0, failed: 0, unknown: 0 },
    }));
    vi.mocked(getDatabase).mockReturnValue(fakeDb());
    try {
      const out = await new SqliteMemoryBackend(instrument).recall(
        "clave acceso",
        opts(),
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]!.content).toBe("Usuario: la clave es [oculto]");
      expect(JSON.stringify(out)).not.toContain(SCRUB_SYN);
    } finally {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error("no db in test");
      });
    }
  });
});
