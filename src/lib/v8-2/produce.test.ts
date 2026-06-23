import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the LLM-calling leaves; keep cite/confidence/judgments-store REAL against
// an in-memory DB so the orchestration (selection, ledger threading, FK-ordered
// persistence, posture normalization, §10 floor, reAuthor revision) is exercised.
vi.mock("./decompose.js", () => ({
  decomposeQuestion: vi.fn(),
  gatherEvidence: vi.fn(),
  DecompositionError: class DecompositionError extends Error {},
}));
vi.mock("./multi-option.js", () => ({ runMultiOption: vi.fn() }));
vi.mock("./author.js", () => ({ authorJudgment: vi.fn() }));
vi.mock("./critic.js", () => ({ runCriticLoop: vi.fn() }));

import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import {
  runJudgmentAssembly,
  selectJudgments,
  deriveStrategicQuestion,
  reRunJudgment,
} from "./produce.js";
import {
  decomposeQuestion,
  gatherEvidence,
  DecompositionError,
} from "./decompose.js";
import { runMultiOption } from "./multi-option.js";
import { authorJudgment } from "./author.js";
import { runCriticLoop } from "./critic.js";
import {
  getJudgmentById,
  getJudgmentsForBriefing,
  insertJudgment,
} from "./judgments-store.js";
import type { Briefing, Judgment } from "../../briefing/schema.js";
import type { EvidenceRef } from "./types.js";

const NOW = "2026-06-19T12:00:00.000Z";

const LEDGER: EvidenceRef[] = [
  { kind: "task", id: "t1", excerpt: "Task one blocked", retrieved_at: NOW },
  { kind: "metric", id: "m1", excerpt: "Metric dropped", retrieved_at: NOW },
  {
    kind: "general_event",
    id: "g1",
    excerpt: "Objective stalled",
    retrieved_at: NOW,
  },
];

// Direct-register prose citing all 3 ledger slots → 3 resolved claims, green.
const DIRECT_PROSE =
  "The task is blocked [1]. The metric dropped [2]. The objective stalled [3].";

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    signal_id: "00000000-0000-0000-0000-000000000001",
    kind: "stalled_task",
    subject: "task-42",
    posture: "at_risk",
    confidence: "green",
    confidence_reason: "three independent sources",
    why: "The task has not moved in eight days and blocks the objective.",
    evidence_indices: [0],
    ...over,
  };
}

function briefing(judgments: Judgment[]): Briefing {
  return {
    briefing_id: "11111111-1111-1111-1111-111111111111",
    surface: "morning",
    generated_at: NOW,
    active_objective_ids: ["NorthStar/objectives/ship-v82"],
    judgments,
  } as unknown as Briefing;
}

/** Seed the FK parent so judgment inserts don't trip the foreign key. */
function seedBriefingRow(briefingId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings
         (briefing_id, surface, generated_at, briefing_json, status, expires_at)
       VALUES (?, 'morning', ?, '{}', 'pending', ?)`,
    )
    .run(briefingId, NOW, "2026-06-20T12:00:00.000Z");
}

const approvedVerdict = {
  verdict: "approved" as const,
  critique: "ok",
  contradictedClaimIds: [],
  iterations: 1,
  latencyMs: 1,
  error: false,
};

beforeEach(() => {
  initDatabase(":memory:");
  vi.mocked(decomposeQuestion).mockResolvedValue({
    question: "q",
    angles: [],
    generated_at: NOW,
  });
  vi.mocked(gatherEvidence).mockReturnValue(LEDGER);
  vi.mocked(runMultiOption).mockResolvedValue({
    options: [],
    degraded: true,
    degradedReason: "no_diversity",
    maxSimilarity: null,
    attempts: 0,
    perspectives: [],
    promptVersion: "v1",
  });
  vi.mocked(authorJudgment).mockResolvedValue({ prose: DIRECT_PROSE });
  vi.mocked(runCriticLoop).mockResolvedValue(approvedVerdict);
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("selectJudgments", () => {
  it("prioritizes highest_leverage > at_risk > recurring_blocker > rest, capped", () => {
    const js = [
      judgment({ subject: "noted-1", posture: "noted", kind: "momentum" }),
      judgment({ subject: "hl", posture: "highest_leverage" }),
      judgment({ subject: "blk", posture: "noted", kind: "recurring_blocker" }),
      judgment({ subject: "risk", posture: "at_risk" }),
    ];
    const picked = selectJudgments(js, 3).map((j) => j.subject);
    expect(picked).toEqual(["hl", "risk", "blk"]);
  });

  it("still yields up to `max` on an all-observational brief (shadow volume)", () => {
    const js = [
      judgment({ subject: "a", posture: "noted", kind: "momentum" }),
      judgment({ subject: "b", posture: "noted", kind: "momentum" }),
    ];
    expect(selectJudgments(js, 3)).toHaveLength(2);
  });
});

describe("deriveStrategicQuestion", () => {
  it("embeds the subject and the why", () => {
    const q = deriveStrategicQuestion(
      judgment({ subject: "x-1", why: "it stalled badly" }),
    );
    expect(q).toContain("x-1");
    expect(q).toContain("it stalled badly");
  });
});

describe("runJudgmentAssembly", () => {
  it("writes a judgment row + attributed_claims, normalizes posture, computes confidence", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    const res = await runJudgmentAssembly(
      briefing([judgment({ posture: "has_momentum" })]),
      { nowIso: NOW, db: getDatabase() },
    );
    expect(res).toEqual({
      attempted: 1,
      written: 1,
      judgmentIds: [res.judgmentIds[0]],
    });

    const rows = getJudgmentsForBriefing(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // has_momentum normalized to the persisted 'momentum' (CHECK would reject otherwise).
    expect(row.posture).toBe("momentum");
    expect(row.prose).toBe(DIRECT_PROSE);
    expect(row.strategicVoicePrincipleId).toBe("strategic_voice_principle_v1");
    expect(row.confidence).toBe("green"); // 3 distinct fresh sources, no contradictions
    expect(row.signalKind).toBe("stalled_task");

    const claims = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM attributed_claims WHERE judgment_id = ?`,
      )
      .get(row.id) as { n: number };
    expect(claims.n).toBe(3); // 3 resolved [K] sentences, 1 ref each

    const trail = JSON.parse(row.criticTrailJson ?? "{}");
    expect(trail.verdict).toBe("approved");
  });

  it("skips a judgment when decomposition fails (no row written)", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    vi.mocked(decomposeQuestion).mockRejectedValueOnce(
      new DecompositionError("model gave no tool call"),
    );
    const res = await runJudgmentAssembly(briefing([judgment()]), {
      nowIso: NOW,
      db: getDatabase(),
    });
    expect(res.written).toBe(0);
    expect(
      getJudgmentsForBriefing("11111111-1111-1111-1111-111111111111"),
    ).toHaveLength(0);
  });

  it("applies the §10 mechanical floor: uncertain prose on a green basis downgrades", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    // 3 fresh distinct sources → computeConfidence = green; but uncertain prose
    // must floor the stored color down (never let confident-color + hedged prose
    // mismatch ship). Uncertain marker "unclear".
    vi.mocked(authorJudgment).mockResolvedValue({
      prose:
        "It is unclear whether the task is blocked [1]. The metric moved [2]. The objective shifted [3].",
    });
    await runJudgmentAssembly(briefing([judgment()]), {
      nowIso: NOW,
      db: getDatabase(),
    });
    const row = getJudgmentsForBriefing(
      "11111111-1111-1111-1111-111111111111",
    )[0];
    // basis was green (3 sources) but uncertain register floors it to red.
    expect(row.confidence).toBe("red");
    const basis = JSON.parse(row.confidenceBasisJson ?? "{}");
    expect(basis.distinct_sources).toBe(3);
  });

  it("the critic-loop reAuthor persists the revised prose + replaces claims", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    const REVISED = "Revised: the task is blocked [1].";
    vi.mocked(authorJudgment)
      .mockResolvedValueOnce({ prose: DIRECT_PROSE }) // initial
      .mockResolvedValueOnce({ prose: REVISED }); // reAuthor
    vi.mocked(runCriticLoop).mockImplementation(async (input, deps) => {
      await deps.reAuthor(input, "tighten the citations");
      return { ...approvedVerdict, iterations: 2 };
    });

    await runJudgmentAssembly(briefing([judgment()]), {
      nowIso: NOW,
      db: getDatabase(),
    });
    const row = getJudgmentsForBriefing(
      "11111111-1111-1111-1111-111111111111",
    )[0];
    expect(row.prose).toBe(REVISED);
    // Revised prose cites only [1] → exactly one attributed_claims row remains.
    const claims = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM attributed_claims WHERE judgment_id = ?`,
      )
      .get(row.id) as { n: number };
    expect(claims.n).toBe(1);
  });

  it("one judgment failing does not sink the batch", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    // First judgment's author throws; second succeeds.
    vi.mocked(authorJudgment)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ prose: DIRECT_PROSE });
    const res = await runJudgmentAssembly(
      briefing([
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000a",
          subject: "a",
        }),
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000b",
          subject: "b",
        }),
      ]),
      { nowIso: NOW, db: getDatabase(), maxJudgments: 2 },
    );
    expect(res.attempted).toBe(2);
    expect(res.written).toBe(1);
  });

  it("assembles the selected judgments concurrently, not serially", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    // Barrier: each author call parks until BOTH have entered. Under serial
    // execution the 2nd judgment never starts (the 1st is parked waiting for a
    // gate only the 2nd can open) → the run deadlocks and the test times out.
    // Concurrency lets both enter, opens the gate, and both resolve.
    let entered = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    vi.mocked(authorJudgment).mockImplementation(async () => {
      entered += 1;
      if (entered === 2) openGate();
      await gate;
      return { prose: DIRECT_PROSE };
    });

    const res = await runJudgmentAssembly(
      briefing([
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000a",
          subject: "a",
        }),
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000b",
          subject: "b",
        }),
      ]),
      { nowIso: NOW, db: getDatabase(), maxJudgments: 2 },
    );

    expect(entered).toBe(2); // both were in-flight at the same time
    expect(res.written).toBe(2);
  });

  it("judgmentIds preserve selection order despite out-of-order completion", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    // Selection order by priority: hl(a) > at_risk(b) > noted(c). Drive authoring
    // to FINISH in the reverse order (c → b → a) via per-subject deferreds so c
    // inserts first (smallest row id) and a last — completion order ≠ selection
    // order. Deterministic (no real timers): judgmentIds must still follow
    // selection (priority) order, not insertion/completion order.
    const release: Record<string, () => void> = {};
    const gate: Record<string, Promise<void>> = {};
    for (const s of ["a", "b", "c"]) {
      gate[s] = new Promise<void>((r) => (release[s] = r));
    }
    const entered: string[] = [];
    vi.mocked(authorJudgment).mockImplementation(async (input) => {
      entered.push(input.subject);
      await gate[input.subject];
      return { prose: DIRECT_PROSE };
    });

    const runPromise = runJudgmentAssembly(
      briefing([
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000a",
          subject: "a",
          posture: "highest_leverage",
        }),
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000b",
          subject: "b",
          posture: "at_risk",
        }),
        judgment({
          signal_id: "00000000-0000-0000-0000-00000000000c",
          subject: "c",
          posture: "noted",
          kind: "stalled_task",
        }),
      ]),
      { nowIso: NOW, db: getDatabase(), maxJudgments: 3 },
    );

    // All three are in-flight (also confirms concurrency); release them c→b→a,
    // flushing each judgment's synchronous insert before releasing the next.
    await vi.waitFor(() => expect(entered).toHaveLength(3));
    for (const s of ["c", "b", "a"]) {
      release[s]();
      await new Promise((r) => setImmediate(r));
    }
    const res = await runPromise;

    const idBySubject = Object.fromEntries(
      (
        getDatabase()
          .prepare(`SELECT subject, id FROM judgments WHERE briefing_id = ?`)
          .all("11111111-1111-1111-1111-111111111111") as {
          subject: string;
          id: number;
        }[]
      ).map((r) => [r.subject, r.id]),
    );

    // judgmentIds[k] is the id of the k-th SELECTED judgment (a, b, c).
    expect(res.judgmentIds).toEqual([
      idBySubject["a"],
      idBySubject["b"],
      idBySubject["c"],
    ]);
    // c completed first → smallest id; a last → largest. So selection order is
    // strictly DESCENDING by id — proving the order is not insertion/completion.
    expect(res.judgmentIds[0]).toBeGreaterThan(res.judgmentIds[2]);
  });

  it("does no work and writes nothing when the caller signal is already aborted", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    const ac = new AbortController();
    ac.abort();
    const res = await runJudgmentAssembly(briefing([judgment()]), {
      nowIso: NOW,
      db: getDatabase(),
      signal: ac.signal,
    });
    expect(res).toEqual({ attempted: 1, written: 0, judgmentIds: [] });
    expect(authorJudgment).not.toHaveBeenCalled();
    expect(
      getJudgmentsForBriefing("11111111-1111-1111-1111-111111111111"),
    ).toHaveLength(0);
  });
});

describe("reRunJudgment (§13 concession)", () => {
  it("folds the operator evidence into the ledger, runs §11, recomputes confidence, persists", async () => {
    seedBriefingRow("11111111-1111-1111-1111-111111111111");
    const id = insertJudgment({
      briefingId: "11111111-1111-1111-1111-111111111111",
      subject: "task-42",
      posture: "at_risk",
      prose: "Original prose [1].",
      createdAt: NOW,
      evidenceRefsJson: JSON.stringify(LEDGER), // pre-append snapshot (no operator msg)
    });
    vi.mocked(authorJudgment).mockResolvedValue({
      prose:
        "Updated: it is blocked [1]. The metric dropped [2]. The objective stalled [3].",
    });

    const row = getJudgmentById(id)!;
    const operatorEvidence: EvidenceRef = {
      kind: "operator_message",
      id: "op-1",
      excerpt: "It unblocked yesterday, see ticket 88",
      retrieved_at: NOW,
    };
    const result = await reRunJudgment(row, operatorEvidence);

    expect(result.prose).toContain("Updated:");
    expect(["green", "yellow", "red"]).toContain(result.confidence);

    // The operator's evidence must reach the ledger the author actually saw —
    // the caller hands reRunJudgment a STALE pre-append snapshot, so the fold
    // happens inside reRunJudgment (audit fix).
    const authorInput = vi.mocked(authorJudgment).mock.calls[0][0];
    expect(authorInput.ledger.some((r) => r.kind === "operator_message")).toBe(
      true,
    );
    // A concession re-run must run the §11 critic (spec §13: §9 + §11 + §12).
    expect(runCriticLoop).toHaveBeenCalled();

    const after = getJudgmentById(id)!;
    expect(after.prose).toBe(result.prose);
    expect(after.confidence).toBe(result.confidence);
  });
});
