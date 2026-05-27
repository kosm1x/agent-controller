/**
 * V8 substrate S2 — submitReport boundary tests.
 *
 * Uses a real in-memory SQLite via initDatabase(":memory:") so the SQL is
 * exercised (CHECK constraint on critic_verdict, UNIQUE on report_id, the
 * ON CONFLICT DO NOTHING idempotency).
 *
 * 2026-05-27 refactor: runCritic now calls `queryClaudeSdk` directly with
 * an inline `submit_verdict` tool (see audit/critic.ts header). These tests
 * mock at that layer — the verdict flows through the tool handler's closure
 * sink, not through free-text JSON parsing. `mockPass()` and `mockFail()`
 * synthesize the SDK's tool-invocation lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import { submitReport, CRITIC_SKIP_FOR } from "./submit-report.js";
import { queryClaudeSdk } from "../inference/claude-sdk.js";
import type { ReportDraft, ReportSurface } from "./report-schema.js";

vi.mock("../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../inference/claude-sdk.js")
  >("../inference/claude-sdk.js");
  return {
    ...actual,
    queryClaudeSdk: vi.fn(),
  };
});

const mockQuery = vi.mocked(queryClaudeSdk);

const T0 = "2026-05-19T00:00:00.000Z";
const T1 = "2026-05-19T01:00:00.000Z";
const SHA256 = "a".repeat(64);

function validDraft(overrides: Partial<ReportDraft> = {}): ReportDraft {
  return {
    report_id: crypto.randomUUID(),
    started_at: T0,
    surface: "morning_brief",
    verified_against: [
      {
        type: "cost_ledger",
        query_sha: SHA256,
        row_count: 42,
        window_start: T0,
        window_end: T1,
        queried_at: T1,
      },
    ],
    sample_n: 42,
    window: { start: T0, end: T1 },
    claims: [
      { statement: "headline claim with enough length", evidence_index: [0] },
    ],
    concerns: [],
    ...overrides,
  };
}

/**
 * Synthesize the SDK invoking `submit_verdict` with the given verdict +
 * critique. Mirrors the real SDK's tool-call lifecycle that runCritic depends
 * on (closure sink captures, query() resolves with empty text + toolCalls).
 */
function simulateVerdict(verdict: "pass" | "fail", critique: string) {
  mockQuery.mockImplementationOnce(async (opts) => {
    const submitVerdict = opts.extraTools?.[0];
    if (submitVerdict) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (submitVerdict as any).handler({ verdict, critique }, {});
    }
    return {
      text: "",
      toolCalls: ["submit_verdict"],
      numTurns: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0.0005,
      costAuthoritative: true,
      durationMs: 20,
      model: "claude-sonnet-4-6",
    };
  });
}

function mockPass() {
  simulateVerdict("pass", "");
}

function mockFail(critique = "headline n=5 not in concerns") {
  simulateVerdict("fail", critique);
}

beforeEach(() => {
  initDatabase(":memory:");
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe("submitReport — schema gate", () => {
  it("rejects malformed draft (missing surface) with structured error", async () => {
    const draft = validDraft();
    // @ts-expect-error deliberately corrupt
    delete draft.surface;
    const r = await submitReport(draft);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("schema");
      expect(r.issues.length).toBeGreaterThan(0);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects empty verified_against", async () => {
    const r = await submitReport(validDraft({ verified_against: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");
  });
});

describe("submitReport — invariant gate", () => {
  it("rejects stale citation", async () => {
    const draft = validDraft({ started_at: T1 });
    draft.verified_against[0].queried_at = T0; // before started_at
    const r = await submitReport(draft);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invariants");
      expect(r.issues.some((i) => i.includes("stale"))).toBe(true);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects evidence_index out of bounds", async () => {
    const draft = validDraft();
    draft.claims[0].evidence_index = [99];
    const r = await submitReport(draft);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invariants");
  });
});

describe("submitReport — pass path", () => {
  it("passes on first critic call → persists with verdict=pass", async () => {
    mockPass();
    const r = await submitReport(validDraft(), { producerCostUsd: 0.01 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("pass");
      expect(r.report.retry_count).toBe(0);
      expect(r.report.critic_cost_usd).toBe(0.0005);
      expect(r.report.producer_cost_usd).toBe(0.01);
    }
    const row = getDatabase()
      .prepare("SELECT * FROM reports WHERE report_id = ?")
      .get(r.ok ? r.report.report_id : "") as Record<string, unknown>;
    expect(row.critic_verdict).toBe("pass");
    expect(row.critic_retries).toBe(0);
  });
});

describe("submitReport — retry path", () => {
  it("revises once, then passes", async () => {
    mockFail();
    mockPass();
    const reviseFn = vi.fn().mockImplementation(async (draft: ReportDraft) => ({
      ...draft,
      concerns: [{ type: "small_sample" as const, detail: "n=5 (added)" }],
    }));

    const r = await submitReport(validDraft(), { reviseFn });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("pass");
      expect(r.report.retry_count).toBe(1);
    }
    expect(reviseFn).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries → returns with fail_returned_anyway + audit_failed concern", async () => {
    // 4 fails total: initial + 3 retries
    mockFail("c1");
    mockFail("c2");
    mockFail("c3");
    mockFail("c4");
    const reviseFn = vi.fn(async (d: ReportDraft) => d);

    const r = await submitReport(validDraft(), { reviseFn });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(r.report.retry_count).toBe(3);
      expect(
        r.report.concerns.some(
          (c) => c.type === "audit_failed" && c.detail === "c4",
        ),
      ).toBe(true);
      expect(r.report.critic_critique).toBe("c4");
    }
    expect(reviseFn).toHaveBeenCalledTimes(3);
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it("returns fail_returned_anyway when no reviseFn provided", async () => {
    mockFail("missing window concern");
    const r = await submitReport(validDraft());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(r.report.retry_count).toBe(0);
    }
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});

describe("submitReport — critic infra failure", () => {
  it("on critic error → folds into audit_failed concern and returns immediately", async () => {
    // Model returned text-only (no submit_verdict tool call) = audit_failed
    // per critic.ts C1 contract.
    mockQuery.mockResolvedValueOnce({
      text: "",
      toolCalls: [],
      numTurns: 0,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0,
      costAuthoritative: true,
      durationMs: 1,
      model: "claude-sonnet-4-6",
    });
    const reviseFn = vi.fn();
    const r = await submitReport(validDraft(), { reviseFn });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(r.report.concerns.some((c) => c.type === "audit_failed")).toBe(
        true,
      );
    }
    // CRITICAL: infra error MUST NOT spend retry budget
    expect(reviseFn).not.toHaveBeenCalled();
  });
});

/**
 * Mutate the runtime allowlist for the duration of `fn`. Lifted into a helper
 * so a thrown assertion inside `fn` still restores allowlist state — avoids
 * cross-test pollution that the raw try/finally pattern was vulnerable to.
 */
async function withAllowlisted<T>(
  surface: ReportSurface,
  fn: () => Promise<T>,
): Promise<T> {
  const mut = CRITIC_SKIP_FOR as Set<ReportSurface>;
  mut.add(surface);
  try {
    return await fn();
  } finally {
    mut.delete(surface);
  }
}

describe("submitReport — allowlist", () => {
  it("CRITIC_SKIP_FOR is empty in Phase 1 (anti-mission guard)", () => {
    expect(CRITIC_SKIP_FOR.size).toBe(0);
  });

  it("if a surface is allowlisted, critic is skipped + schema still enforced", async () => {
    await withAllowlisted("morning_brief", async () => {
      const r = await submitReport(validDraft());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.report.critic_verdict).toBe("skipped_allowlist");
        expect(r.report.retry_count).toBe(0);
      }
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  it("schema fail still rejects even when surface allowlisted", async () => {
    await withAllowlisted("morning_brief", async () => {
      const r = await submitReport(validDraft({ verified_against: [] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("schema");
    });
  });
});

describe("submitReport — persistence", () => {
  it("records produced_at, surface, and JSON blob", async () => {
    mockPass();
    const draft = validDraft();
    const r = await submitReport(draft);
    expect(r.ok).toBe(true);

    const row = getDatabase()
      .prepare("SELECT * FROM reports WHERE report_id = ?")
      .get(draft.report_id) as Record<string, unknown>;
    expect(row.surface).toBe("morning_brief");
    expect(typeof row.produced_at).toBe("string");
    expect(row.started_at).toBe(T0);

    const blob = JSON.parse(row.report_json as string);
    expect(blob.report_id).toBe(draft.report_id);
    expect(blob.critic_verdict).toBe("pass");
  });

  it("ON CONFLICT DO NOTHING — re-submitting same report_id leaves first record", async () => {
    mockPass();
    const draft = validDraft();
    await submitReport(draft);

    mockPass();
    const second = await submitReport(draft);
    expect(second.ok).toBe(true);

    const rows = getDatabase()
      .prepare("SELECT COUNT(*) as c FROM reports WHERE report_id = ?")
      .get(draft.report_id) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("revision schema-break mid-loop returns structured error, does not persist", async () => {
    mockFail("force-revise");
    const draft = validDraft();
    const reviseFn = vi.fn(async (d: ReportDraft) => {
      // Producer breaks the contract: hands back something invalid
      return { ...d, verified_against: [] } as ReportDraft;
    });

    const r = await submitReport(draft, { reviseFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");

    const row = getDatabase()
      .prepare("SELECT COUNT(*) as c FROM reports WHERE report_id = ?")
      .get(draft.report_id) as { c: number };
    expect(row.c).toBe(0);
  });

  it("oversize report_json skips persistence (logs warning, returns in-memory)", async () => {
    mockPass();
    const draft = validDraft();
    // 300 KB of padding > REPORT_JSON_MAX_BYTES (256 KB)
    draft.claims[0].statement = "x".repeat(300_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await submitReport(draft);
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds"));
    const row = getDatabase()
      .prepare("SELECT COUNT(*) as c FROM reports WHERE report_id = ?")
      .get(draft.report_id) as { c: number };
    expect(row.c).toBe(0);
    warn.mockRestore();
  });

  it("re-submitting same report_id logs producer-bug warning", async () => {
    mockPass();
    const draft = validDraft();
    await submitReport(draft);

    mockPass();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await submitReport(draft);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("already persisted"),
    );
    warn.mockRestore();
  });
});

describe("submitReport — reviseFn safety", () => {
  it("reviseFn throwing → folded into audit_failed concern, no unhandled rejection", async () => {
    mockFail("first fail");
    const reviseFn = vi.fn(async () => {
      throw new Error("producer LLM 503");
    });
    const r = await submitReport(validDraft(), { reviseFn });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(r.report.retry_count).toBe(1);
      expect(
        r.report.concerns.some(
          (c) =>
            c.type === "audit_failed" &&
            c.detail.includes("reviseFn threw") &&
            c.detail.includes("producer LLM 503"),
        ),
      ).toBe(true);
    }
    expect(reviseFn).toHaveBeenCalledOnce();
  });
});

describe("submitReport — abort/signal hygiene", () => {
  it("caller signal already aborted → critic short-circuits, no infer call", async () => {
    const ac = new AbortController();
    ac.abort(new Error("caller budget exhausted"));
    const r = await submitReport(validDraft(), {
      criticOptions: { signal: ac.signal },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(
        r.report.concerns.some(
          (c) =>
            c.type === "audit_failed" &&
            c.detail.includes("caller signal already aborted"),
        ),
      ).toBe(true);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("timeoutMs fires before caller signal → cleans up both cleanup paths", async () => {
    const ac = new AbortController();
    mockQuery.mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const r = await submitReport(validDraft(), {
      criticOptions: { signal: ac.signal, timeoutMs: 30 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.critic_verdict).toBe("fail_returned_anyway");
      expect(r.report.concerns.some((c) => c.type === "audit_failed")).toBe(
        true,
      );
    }
  });
});
