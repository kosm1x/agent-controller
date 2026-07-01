/**
 * V8.2 Phase 6 — §11 CRITIC tests.
 *
 * `queryClaudeSdk` is mocked dispatch-by-shape: the mock finds the
 * `submit_critic_verdict` tool in `extraTools` and invokes its handler with a
 * scripted verdict (or returns no tool call / throws). This exercises the
 * forced-tool capture, the tri-state verdicts, the 2-loop escalation and the
 * contradiction-write wiring without a real LLM. The read-only verification
 * tools are tested as pure functions against a real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  runCritic,
  runCriticLoop,
  escalationDisposition,
  runReadOnlySelect,
  runCostCheck,
  runRecallCheck,
  runFileSha,
  sanitizeFtsQuery,
  CRITIC_MAX_LOOP,
  CRITIC_SYSTEM_PROMPT_V1,
  SQL_CHECK_TOOL_DESCRIPTION,
  type CriticInput,
  type CriticVerdict,
} from "./critic.js";
import {
  resolveCitations,
  persistAttributedClaims,
  countContradictions,
} from "./cite.js";
import type { EvidenceRef } from "./types.js";

describe("CRITIC_SYSTEM_PROMPT_V1 — verification discipline", () => {
  it("forbids name-prefix entity conflation and fuzzy override of deterministic figures", () => {
    // Regression: judgment 19 — the critic read a 'Very Light CMS' (vlcms)
    // day-log entry as evidence for 'Very Light Media Player' (vlmp) and
    // overturned a CORRECT deterministic stall-detector figure ("absent 27
    // days") with a fuzzy LIKE hit, falsely marking a TRUE claim contradicted.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain("VERIFICATION DISCIPLINE");
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain("ENTITY IDENTITY");
    // Names the exact sibling-collision so the rule is concrete, not abstract.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      '"Very Light CMS" (vlcms) is NOT "Very Light Media Player" (vlmp)',
    );
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      "A FUZZY HIT DOES NOT OUTRANK A DETERMINISTIC FIGURE",
    );
    // Pin the safety conditional — the ONLY clause stopping rule 2 from becoming
    // a blanket "deterministic figure always wins" suppressor. A reword that drops
    // it would turn the critic into a rubber-stamp for REAL contradictions while
    // every other assertion here still passed green.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      "ONLY if it lands on the EXACT subject entity AND inside the claimed window",
    );
    // The asymmetry: a false contradiction of a true claim is the costlier error.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      "marking a TRUE claim contradicted is the costlier error",
    );
  });

  it("forbids treating a self-authored 0-row query as proof of absence (judgment 32 regression)", () => {
    // Regression: judgment 32 — the critic queried the `tasks` table by the
    // integer `id` column for 10 real `task_id` UUIDs, got 0 rows each, and
    // falsely concluded the whole evidence ledger was nonexistent → unfixable.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      "YOUR OWN 0-ROW QUERY IS NOT PROOF OF ABSENCE",
    );
    // Names the exact key-column trap so the rule is concrete.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      'keys on "task_id" (a TEXT UUID), NOT the integer "id"',
    );
    // The disposition: never contradict on a self-authored 0-row result.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain("EXISTS by construction");
    // Pin the SCOPE-LIMITER (qa-W1): rule 3 must stay gated to 0-row results, not
    // widen into a blanket "never contradict" suppressor. A reword dropping this
    // clause would rubber-stamp REAL value-contradictions while this test still
    // passed green — mirrors the rule-2 safety-clause pin above.
    expect(CRITIC_SYSTEM_PROMPT_V1).toContain(
      "on the strength of a 0-row result",
    );
  });
});

describe("sql_check tool — schema guidance (ACI)", () => {
  it("tells the critic that a task ref keys on tasks.task_id, not the integer id", () => {
    // The critic authors free-form SQL; without this the LLM defaults to
    // `WHERE id = '<uuid>'` (int column vs UUID → silent 0 rows). ACI fix at the
    // point the model writes the query (judgment 32 regression).
    expect(SQL_CHECK_TOOL_DESCRIPTION).toContain("tasks.task_id");
    expect(SQL_CHECK_TOOL_DESCRIPTION).toContain("INTEGER rowid");
    expect(SQL_CHECK_TOOL_DESCRIPTION).toContain("WHERE task_id = '<uuid>'");
    // Phase-2 kb_entry refs (id=path) carry the same key-column trap live now (I2).
    expect(SQL_CHECK_TOOL_DESCRIPTION).toContain("jarvis_files.path");
  });
});

vi.mock("../../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../inference/claude-sdk.js")
  >("../../inference/claude-sdk.js");
  return { ...actual, queryClaudeSdk: vi.fn() };
});

const mockQuery = vi.mocked(queryClaudeSdk);

const SDK_RESULT = {
  text: "",
  toolCalls: ["submit_critic_verdict"] as string[],
  numTurns: 2,
  usage: {
    promptTokens: 200,
    completionTokens: 30,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  costUsd: 0.003,
  costAuthoritative: true,
  durationMs: 80,
  model: "claude-sonnet-4-6",
};

type VerdictArgs = {
  verdict: CriticVerdict;
  critique: string;
  contradicted_claim_ids?: number[];
};
type Step = VerdictArgs | "no_tool" | "throw" | "throw_after_capture";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSubmit(opts: any) {
  return opts.extraTools.find(
    (t: { name: string }) => t.name === "submit_critic_verdict",
  );
}

/** Install the dispatch-by-shape mock with a verdict (or a sequence). */
function installCritic(seq: Step | Step[]) {
  const steps = Array.isArray(seq) ? seq : [seq];
  let i = 0;
  mockQuery.mockImplementation(async (o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = o as any;
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step === "throw") throw new Error("api down");
    if (step === "no_tool") return { ...SDK_RESULT, toolCalls: [] };
    const submit = findSubmit(opts);
    if (step === "throw_after_capture") {
      await submit.handler({ verdict: "approved", critique: "ok" }, {});
      throw new Error("aborted after capture");
    }
    await submit.handler(step, {});
    return { ...SDK_RESULT };
  });
}

const LEDGER: EvidenceRef[] = [
  {
    kind: "task",
    id: "t-1",
    excerpt: "[blocked] ship the pilot",
    retrieved_at: "now",
  },
  { kind: "metric", id: "m-1", excerpt: "conversion 12%", retrieved_at: "now" },
];

const INPUT: CriticInput = {
  prose: "The pilot is blocked [1].",
  claims: [
    {
      claim_id: 1,
      claim_text: "The pilot is blocked [1].",
      prose_offset: 0,
      evidence_refs: [LEDGER[0]],
      resolver_status: "resolved",
    },
  ],
  ledger: LEDGER,
};

beforeEach(() => {
  initDatabase(":memory:"); // getDatabase() used by runCritic's readonly fallback + finalize
});
afterEach(() => {
  vi.clearAllMocks();
  closeDatabase();
});

describe("runCritic — forced tri-state verdict", () => {
  for (const v of ["approved", "needs_revision", "unfixable"] as const) {
    it(`captures a ${v} verdict`, async () => {
      installCritic({ verdict: v, critique: `${v} because reasons` });
      const r = await runCritic(INPUT);
      expect(r.verdict).toBe(v);
      expect(r.error).toBe(false);
      expect(r.contradictedClaimIds).toEqual([]);
      expect(r.critique).toContain("reasons");
    });
  }

  it("returns a conservative needs_revision + error when no tool is called", async () => {
    installCritic("no_tool");
    const r = await runCritic(INPUT);
    expect(r.verdict).toBe("needs_revision");
    expect(r.error).toBe(true);
    expect(r.critique).toMatch(/did not call submit_critic_verdict/);
  });

  it("honors a verdict captured just before an abort throw", async () => {
    installCritic("throw_after_capture");
    const r = await runCritic(INPUT);
    expect(r.verdict).toBe("approved");
    expect(r.error).toBe(false);
  });

  it("returns error needs_revision on a hard call failure", async () => {
    installCritic("throw");
    const r = await runCritic(INPUT);
    expect(r.verdict).toBe("needs_revision");
    expect(r.error).toBe(true);
    expect(r.critique).toMatch(/critic call failed/);
  });

  it("does not call the model when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runCritic(INPUT, { signal: ac.signal });
    expect(r.error).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("dedupes + integer-filters contradicted_claim_ids in the capture", async () => {
    installCritic({
      verdict: "unfixable",
      critique: "claim 1 is false",
      contradicted_claim_ids: [1, 1, 2],
    });
    const r = await runCritic(INPUT); // no judgmentId → no DB write, just capture
    expect(r.contradictedClaimIds).toEqual([1, 2]);
  });

  it("opens + closes a readonly connection to the live db FILE when no queryDb is injected (qa-W2)", async () => {
    // Exercise the production ownConn branch: a real file path (not :memory:)
    // makes runCritic open a fresh readonly connection and close it in finally.
    closeDatabase();
    const dir = mkdtempSync(join(tmpdir(), "critic-rodb-"));
    initDatabase(join(dir, "mc.db"));
    installCritic({ verdict: "approved", critique: "ok" });
    const r = await runCritic(INPUT); // no queryDb → readonly-open + finally-close
    expect(r.verdict).toBe("approved");
    expect(r.error).toBe(false);
  });
});

describe("runCritic — contradiction write wiring (§11 → §12)", () => {
  /** Seed proposed_briefings + judgments + 2 claims; claim 1 is multi-source. */
  function seedJudgmentWithClaims(): number {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES (?,?,?,?,?)`,
    ).run(
      "b1",
      "morning",
      "2026-01-01T00:00:00Z",
      "{}",
      "2099-01-01T00:00:00Z",
    );
    const info = db
      .prepare(
        `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run("b1", "CRM pilot", "at_risk", "prose", "2026-01-01T00:00:00Z");
    const jid = Number(info.lastInsertRowid);
    // claim 0: [1] → 1 row; claim 1: [1][2] → 2 rows
    const { resolved } = resolveCitations(
      "Blocked [1]. Conversion stalling [1][2].",
      LEDGER,
    );
    persistAttributedClaims(jid, resolved, db);
    return jid;
  }

  it("flips the contradicted claim's rows to contradicted when judgmentId is set", async () => {
    const jid = seedJudgmentWithClaims();
    installCritic({
      verdict: "unfixable",
      critique: "claim 1 contradicted by cost_ledger",
      contradicted_claim_ids: [1],
    });
    const r = await runCritic(
      { ...INPUT, judgmentId: jid },
      { queryDb: getDatabase(), writeDb: getDatabase() },
    );
    expect(r.verdict).toBe("unfixable");
    expect(r.contradictedClaimIds).toEqual([1]);
    expect(countContradictions(jid, getDatabase())).toBe(1); // distinct claim
    const flipped = getDatabase()
      .prepare(
        "SELECT resolver_status FROM attributed_claims WHERE judgment_id=? AND claim_id=1",
      )
      .all(jid) as { resolver_status: string }[];
    expect(flipped).toHaveLength(2);
    expect(flipped.every((x) => x.resolver_status === "contradicted")).toBe(
      true,
    );
  });

  it("writes nothing when there are no contradicted ids", async () => {
    const jid = seedJudgmentWithClaims();
    installCritic({ verdict: "approved", critique: "all grounded" });
    await runCritic(
      { ...INPUT, judgmentId: jid },
      { queryDb: getDatabase(), writeDb: getDatabase() },
    );
    expect(countContradictions(jid, getDatabase())).toBe(0);
  });
});

describe("runCriticLoop — 2-loop (Self-Refine)", () => {
  it("returns on the first approved verdict without re-authoring", async () => {
    installCritic({ verdict: "approved", critique: "grounded" });
    const reAuthor = vi.fn();
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("approved");
    expect(r.iterations).toBe(1);
    expect(reAuthor).not.toHaveBeenCalled();
  });

  it("re-authors on needs_revision then approves on the second pass", async () => {
    installCritic([
      { verdict: "needs_revision", critique: "fix the date in claim 1" },
      { verdict: "approved", critique: "good now" },
    ]);
    const reAuthor = vi.fn(async (_input: CriticInput, _critique: string) => ({
      prose: "The pilot is blocked as of 2026-01-02 [1].",
      claims: INPUT.claims,
    }));
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("approved");
    expect(r.iterations).toBe(2);
    expect(reAuthor).toHaveBeenCalledTimes(1);
    // critique from pass 1 is injected into the re-author
    expect(reAuthor.mock.calls[0][1]).toMatch(/fix the date/);
  });

  it("finalizes approved-with-caveat when two needs_revision passes contradict nothing (verified, correctable-only)", async () => {
    // The re-author couldn't fully satisfy a sourcing/citation nit, but the
    // critic VERIFIED and disproved nothing → the judgment is substantively
    // sound. §11 reserves `unfixable` for CONTRADICTED claims, so this must NOT
    // be dropped as unfixable — it surfaces approved with the residual caveat.
    installCritic([
      {
        verdict: "needs_revision",
        critique: "citation [1] points at the wrong task",
      },
      { verdict: "needs_revision", critique: "still the wrong source id" },
    ]);
    const reAuthor = vi.fn(async () => ({
      prose: "revised",
      claims: INPUT.claims,
    }));
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("approved");
    expect(r.iterations).toBe(CRITIC_MAX_LOOP);
    expect(r.critique).toMatch(
      /approved with residual citation\/sourcing caveat/,
    );
    expect(reAuthor).toHaveBeenCalledTimes(1); // re-authored once, then finalized
  });

  it("keeps unfixable when an unsupported sentence survives both passes (not merely mis-cited — qa-W1)", async () => {
    // INPUT_WITH_UNRESOLVED carries an unsupported sentence; the re-author fails
    // to clear it (returns the same unresolved), so the terminal disposition must
    // NOT approve it despite no contradiction.
    installCritic([
      {
        verdict: "needs_revision",
        critique: "the legal-blocker sentence is unsupported",
      },
      { verdict: "needs_revision", critique: "still unsupported" },
    ]);
    const reAuthor = vi.fn(async (input: CriticInput) => ({
      prose: "revised but still unsupported",
      claims: INPUT.claims,
      unresolved: input.unresolved, // re-author did NOT remove the flagged sentence
    }));
    const r = await runCriticLoop(
      {
        ...INPUT,
        unresolved: [
          {
            claim_text: "legal is the blocker",
            prose_offset: 0,
            reason: "no_marker_factual",
            invalid_markers: [],
          },
        ],
      },
      { reAuthor },
    );
    expect(r.verdict).toBe("unfixable");
    expect(r.critique).toMatch(/unsupported sentence still unresolved/);
  });

  it("approves after the re-author REMOVES the flagged unsupported sentence (intended happy path)", async () => {
    installCritic([
      {
        verdict: "needs_revision",
        critique: "remove the unsupported legal-blocker sentence",
      },
      {
        verdict: "needs_revision",
        critique: "citation nit remains but nothing contradicted",
      },
    ]);
    const reAuthor = vi.fn(async () => ({
      prose: "revised, unsupported sentence removed",
      claims: INPUT.claims,
      unresolved: [], // re-author cleared it → clears the unresolved gate
    }));
    const r = await runCriticLoop(
      {
        ...INPUT,
        unresolved: [
          {
            claim_text: "legal is the blocker",
            prose_offset: 0,
            reason: "no_marker_factual",
            invalid_markers: [],
          },
        ],
      },
      { reAuthor },
    );
    expect(r.verdict).toBe("approved");
    expect(r.critique).toMatch(
      /approved with residual citation\/sourcing caveat/,
    );
  });

  it("escalates to unfixable when the second needs_revision carries a contradiction", async () => {
    installCritic([
      { verdict: "needs_revision", critique: "check claim 1" },
      {
        verdict: "needs_revision",
        critique: "claim 1 is contradicted by ground truth",
        contradicted_claim_ids: [1],
      },
    ]);
    const reAuthor = vi.fn(async () => ({
      prose: "revised",
      claims: INPUT.claims,
    }));
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("unfixable");
    expect(r.critique).toMatch(/escalated to unfixable/);
  });

  it("escalates to unfixable when the critic could not verify on the last pass (infra error)", async () => {
    installCritic([
      { verdict: "needs_revision", critique: "check it" },
      "no_tool",
    ]);
    const reAuthor = vi.fn(async () => ({
      prose: "revised",
      claims: INPUT.claims,
    }));
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("unfixable");
    expect(r.critique).toMatch(/could not verify/);
  });

  it("is terminal on a first-pass unfixable without re-authoring", async () => {
    installCritic({ verdict: "unfixable", critique: "contradicted" });
    const reAuthor = vi.fn();
    const r = await runCriticLoop(INPUT, { reAuthor });
    expect(r.verdict).toBe("unfixable");
    expect(r.iterations).toBe(1);
    expect(reAuthor).not.toHaveBeenCalled();
  });
});

describe("escalationDisposition — §11 terminal semantics", () => {
  const base = {
    critique: "the residual problem",
    contradictedClaimIds: [] as number[],
    latencyMs: 1,
    error: false,
  };

  it("infra error → unfixable (never auto-approve the unverified)", () => {
    const d = escalationDisposition(
      { ...base, verdict: "needs_revision", error: true },
      0,
    );
    expect(d.verdict).toBe("unfixable");
    expect(d.critique).toMatch(/could not verify/);
  });

  it("a contradicted claim → unfixable (a claim proven false by the tools)", () => {
    const d = escalationDisposition(
      { ...base, verdict: "needs_revision", contradictedClaimIds: [7] },
      0,
    );
    expect(d.verdict).toBe("unfixable");
    expect(d.critique).toMatch(/escalated to unfixable/);
  });

  it("a surviving unsupported sentence → unfixable (unresolved has no claim_id, so the discriminator is blind to it — qa-W1)", () => {
    const d = escalationDisposition(
      { ...base, verdict: "needs_revision" },
      1, // one unresolved (unsupported) sentence still present
    );
    expect(d.verdict).toBe("unfixable");
    expect(d.critique).toMatch(/unsupported sentence still unresolved/);
  });

  it("verified + nothing contradicted + no unsupported sentence → approved-with-caveat (correctable citation nit only)", () => {
    const d = escalationDisposition({ ...base, verdict: "needs_revision" }, 0);
    expect(d.verdict).toBe("approved");
    expect(d.critique).toMatch(
      /approved with residual citation\/sourcing caveat/,
    );
    // the residual critique is preserved in the critic trail (audit-trail only,
    // via `mc-ctl judgments` — NOT rendered in the operator's brief)
    expect(d.critique).toContain("the residual problem");
  });
});

describe("verification tools — read-only guards", () => {
  it("sanitizeFtsQuery quotes alnum tokens and ORs them; empty when no tokens", () => {
    expect(sanitizeFtsQuery("Hello World!")).toBe('"hello" OR "world"');
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("  @#$ -- ")).toBe("");
  });

  describe("runReadOnlySelect", () => {
    it("rejects anything that is not a single SELECT", () => {
      const db = getDatabase();
      expect(runReadOnlySelect(db, "DELETE FROM tasks")).toMatch(
        /only a single read-only SELECT/,
      );
      expect(runReadOnlySelect(db, "UPDATE tasks SET status='x'")).toMatch(
        /only a single read-only SELECT/,
      );
      // WITH is rejected up front (could front a writing CTE)
      expect(
        runReadOnlySelect(db, "WITH x AS (SELECT 1) SELECT * FROM x"),
      ).toMatch(/only a single read-only SELECT/);
    });

    it("rejects tables outside the ground-truth whitelist", () => {
      const out = runReadOnlySelect(
        getDatabase(),
        "SELECT * FROM conversations",
      );
      expect(out).toMatch(/outside the ground-truth whitelist/);
      expect(out).toMatch(/conversations/);
    });

    it("rejects a comma-join smuggling a non-whitelisted table (qa-W1)", () => {
      const out = runReadOnlySelect(
        getDatabase(),
        "SELECT * FROM tasks, conversations",
      );
      expect(out).toMatch(/outside the ground-truth whitelist/);
      expect(out).toMatch(/conversations/);
    });

    it("runs a whitelisted SELECT and reports the row count", () => {
      const out = runReadOnlySelect(
        getDatabase(),
        "SELECT COUNT(*) AS n FROM tasks",
      );
      expect(out).toMatch(/^1 row\(s\):/);
    });

    it("surfaces a multi-statement attempt as an error (prepare rejects it)", () => {
      expect(runReadOnlySelect(getDatabase(), "SELECT 1; SELECT 2")).toMatch(
        /sql_check error/,
      );
    });

    it("caps the result at 50 rows", () => {
      const db = getDatabase();
      const ins = db.prepare(
        `INSERT INTO cost_ledger (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (let i = 0; i < 55; i++) {
        ins.run(`r${i}`, `t${i}`, "fast", "claude-sonnet-4-6", 10, 5, 0.001);
      }
      const out = runReadOnlySelect(db, "SELECT * FROM cost_ledger");
      expect(out).toMatch(/^50 row\(s\) \(capped at 50; more rows exist\)/);
    });
  });

  it("runCostCheck aggregates cost_ledger over the window", () => {
    const db = getDatabase();
    const ins = db.prepare(
      `INSERT INTO cost_ledger (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?,?,?,?,?,?,?)`,
    );
    ins.run("r1", "t1", "fast", "claude-sonnet-4-6", 100, 50, 0.01);
    ins.run("r2", "t2", "fast", "claude-sonnet-4-6", 200, 80, 0.02);
    const out = JSON.parse(runCostCheck(db, { window_days: 7 }));
    expect(out.row_count).toBe(2);
    expect(out.total_cost_usd).toBeCloseTo(0.03, 6);
    expect(out.total_prompt_tokens).toBe(300);
    expect(out.window_days).toBe(7);
  });

  it("runRecallCheck does a lexical FTS lookup over jarvis_files", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
    ).run("f1", "kb/pilot.md", "Pilot", "the crm pilot is blocked on legal");
    const hit = runRecallCheck(db, "pilot blocked");
    expect(hit).toMatch(/kb\/pilot\.md|lexical/);
    expect(runRecallCheck(db, "")).toMatch(/empty query/);
    expect(runRecallCheck(db, "zzqqxx-nomatch")).toMatch(/no KB matches/);
  });

  it("runFileSha hashes a repo file, rejects traversal, reports missing", () => {
    const root = process.cwd();
    const ok = JSON.parse(runFileSha(root, "package.json"));
    expect(ok.exists).toBe(true);
    expect(ok.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runFileSha(root, "../../../etc/passwd")).toMatch(
      /escapes the repo root/,
    );
    const missing = JSON.parse(runFileSha(root, "no-such-file-xyz.md"));
    expect(missing.exists).toBe(false);
  });
});
