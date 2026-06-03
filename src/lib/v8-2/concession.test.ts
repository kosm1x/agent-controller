/**
 * V8.2 Phase 7 — §13 Concession handler tests.
 *
 * `queryClaudeSdk` is mocked dispatch-by-shape (same pattern as critic.test):
 * the mock finds the `submit_reply_class` tool in `extraTools` and invokes its
 * handler with a scripted classification (or returns no tool call / throws).
 * The evidence gate + handlePushback run against a REAL in-memory DB with a
 * seeded `judgments` row (and its `proposed_briefings` parent for the FK).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  classifyReply,
  handlePushback,
  isForwardLooking,
  replyCarriesEvidence,
  type ReRunJudgmentFn,
} from "./concession.js";
import {
  appendEvidenceRef,
  getJudgmentById,
  type JudgmentRow,
} from "./judgments-store.js";

vi.mock("../../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../inference/claude-sdk.js")
  >("../../inference/claude-sdk.js");
  return { ...actual, queryClaudeSdk: vi.fn() };
});

const mockQuery = vi.mocked(queryClaudeSdk);

const SDK_RESULT = {
  text: "",
  toolCalls: ["submit_reply_class"] as string[],
  numTurns: 1,
  usage: {
    promptTokens: 120,
    completionTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  costUsd: 0.001,
  costAuthoritative: true,
  durationMs: 40,
  model: "claude-sonnet-4-6",
};

type ClassArgs = {
  class: "promote" | "discard" | "pushback";
  judgment_id?: number;
  rationale: string;
};
type Step = ClassArgs | "no_tool" | "throw";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSubmit(opts: any) {
  return opts.extraTools.find(
    (t: { name: string }) => t.name === "submit_reply_class",
  );
}

function installClassifier(step: Step) {
  mockQuery.mockImplementation(async (o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = o as any;
    if (step === "throw") throw new Error("api down");
    if (step === "no_tool") return { ...SDK_RESULT, toolCalls: [] };
    const submit = findSubmit(opts);
    await submit.handler(step, {});
    return { ...SDK_RESULT };
  });
}

const NOW = "2026-06-03T12:00:00.000Z";
const PLUS_72H = "2026-06-06T12:00:00.000Z";

/** A full JudgmentRow for classifier tests (no DB needed). */
function mkJudgment(over: Partial<JudgmentRow> = {}): JudgmentRow {
  return {
    id: 1,
    briefingId: "b1",
    subject: "CRM beta pilot",
    posture: "at_risk",
    prose: "The pilot is at risk of slipping further [1].",
    confidence: "yellow",
    signalKind: null,
    signalLastSeenAt: null,
    createdAt: NOW,
    evidenceRefsJson: null,
    proposedOptionsJson: null,
    strategicVoicePrincipleId: null,
    concessionKind: null,
    triggeringEvidenceText: null,
    confidenceBasisJson: null,
    criticTrailJson: null,
    ...over,
  };
}

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  vi.clearAllMocks();
  closeDatabase();
});

// ── evidence gate ─────────────────────────────────────────────────────────────

describe("replyCarriesEvidence", () => {
  // The §14 control probes carry NO evidence — they MUST read false (the whole
  // experiment depends on a bare "are you sure?" not being treated as evidence).
  const PROBES_NO_EVIDENCE = [
    "I don't think that's right, are you sure?",
    "Hmm, I'm not convinced. Reconsider.",
    "That doesn't seem correct to me.",
    "Are you sure about that? I'd push back.",
    "I disagree with that read.",
    "no estoy de acuerdo",
    "creo que te equivocas",
    "",
    "   ",
    // qa-C1 regressions: a bare disagreement that RESTATES the disputed claim's
    // state-vocabulary or NAMES its subject must read as NO evidence (else the
    // consent layer folds without evidence — the §13 failure).
    "I don't think the pilot is at risk", // restates "at risk"
    "the deal is not lost", // restates "lost"
    "I disagree, it's not slipping", // restates "slipping"
    "no, it didn't fail", // restates "fail"
    "it hasn't churned", // restates "churned"
    "you're wrong about Acme", // bare subject name, not evidence
    "el proyecto no está en riesgo", // ES restatement
    // qa-R2 W-residual: NAMING an artifact without citing it is not evidence.
    "the client is fine, you're wrong", // bare "the client", no attribution
    "that's not right, the contract claim is wrong", // bare "the contract"
    "you're wrong about the report", // bare "the report"
  ];
  for (const p of PROBES_NO_EVIDENCE) {
    it(`no evidence: ${JSON.stringify(p)}`, () => {
      expect(replyCarriesEvidence(p)).toBe(false);
    });
  }

  const HAS_EVIDENCE = [
    "the customer said churn would spike", // marker
    "según el contrato que firmaron", // ES marker
    'me dijo "no vamos a renovar"', // marker + quote
    "revenue dropped 30% last quarter", // number
    "Acme cancelled the renewal on Friday", // date (a bare name is NOT enough)
    "they signed on Tuesday", // date
    "ya van 3 meses de retraso", // number
    'the report says "it stalled"', // marker + quote
  ];
  for (const e of HAS_EVIDENCE) {
    it(`has evidence: ${JSON.stringify(e)}`, () => {
      expect(replyCarriesEvidence(e)).toBe(true);
    });
  }
});

// ── isForwardLooking ──────────────────────────────────────────────────────────

describe("isForwardLooking", () => {
  it("at_risk posture is always forward-looking", () => {
    expect(
      isForwardLooking(mkJudgment({ posture: "at_risk", prose: "static." })),
    ).toBe(true);
  });
  it("a neutral 'noted' judgment is not forward-looking", () => {
    expect(
      isForwardLooking(
        mkJudgment({
          posture: "noted",
          subject: "weekly log",
          prose: "Logged for awareness.",
        }),
      ),
    ).toBe(false);
  });
  it("a 'noted' judgment whose prose predicts is forward-looking", () => {
    expect(
      isForwardLooking(
        mkJudgment({
          posture: "noted",
          subject: "weekly log",
          prose: "Margins may slip further next month.",
        }),
      ),
    ).toBe(true);
  });
});

// ── classifyReply ─────────────────────────────────────────────────────────────

describe("classifyReply", () => {
  it("captures a promote classification", async () => {
    installClassifier({ class: "promote", rationale: "engaged" });
    const r = await classifyReply("gracias, lo reviso", [mkJudgment()]);
    expect(r).toMatchObject({ cls: "promote", judgmentId: null, error: false });
  });

  it("captures a discard classification", async () => {
    installClassifier({ class: "discard", rationale: "rejected whole brief" });
    const r = await classifyReply("descártalo", [mkJudgment()]);
    expect(r).toMatchObject({ cls: "discard", error: false });
  });

  it("captures a pushback with a valid judgment_id", async () => {
    installClassifier({
      class: "pushback",
      judgment_id: 7,
      rationale: "disputes",
    });
    const r = await classifyReply("no creo que el pilot esté en riesgo", [
      mkJudgment({ id: 7 }),
    ]);
    expect(r).toMatchObject({ cls: "pushback", judgmentId: 7, error: false });
  });

  it("repairs a pushback with a missing id when only one judgment exists", async () => {
    installClassifier({ class: "pushback", rationale: "disputes, no id" });
    const r = await classifyReply("eso está mal", [mkJudgment({ id: 9 })]);
    expect(r).toMatchObject({ cls: "pushback", judgmentId: 9 });
  });

  it("downgrades an unresolvable pushback to promote when several judgments exist", async () => {
    installClassifier({
      class: "pushback",
      judgment_id: 999,
      rationale: "bad id",
    });
    const r = await classifyReply("eso está mal", [
      mkJudgment({ id: 1 }),
      mkJudgment({ id: 2 }),
    ]);
    // Never guess a target → treat as engagement, never a concession.
    expect(r).toMatchObject({ cls: "promote", judgmentId: null });
  });

  it("returns cls=null (caller falls back to regex) when the model calls no tool", async () => {
    installClassifier("no_tool");
    const r = await classifyReply("hola", [mkJudgment()]);
    expect(r).toMatchObject({ cls: null, error: true });
  });

  it("returns cls=null on an SDK error — never a fabricated pushback", async () => {
    installClassifier("throw");
    const r = await classifyReply("hola", [mkJudgment()]);
    expect(r).toMatchObject({ cls: null, judgmentId: null, error: true });
  });
});

// ── handlePushback (real DB) ──────────────────────────────────────────────────

/** Seed proposed_briefings + a judgments row; return the judgment PK. */
function seedJudgment(
  over: {
    posture?: JudgmentRow["posture"];
    prose?: string;
    subject?: string;
  } = {},
): number {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO proposed_briefings
       (briefing_id, surface, generated_at, briefing_json, expires_at)
     VALUES (?,?,?,?,?)`,
  ).run("b1", "morning", NOW, "{}", "2999-01-01T00:00:00.000Z");
  const info = db
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      "b1",
      over.subject ?? "CRM beta pilot",
      over.posture ?? "at_risk",
      over.prose ?? "The pilot is at risk of slipping further.",
      NOW,
    );
  return Number(info.lastInsertRowid);
}

function concessionKind(id: number): string | null {
  return (
    getDatabase()
      .prepare(`SELECT concession_kind FROM judgments WHERE id = ?`)
      .get(id) as { concession_kind: string | null }
  ).concession_kind;
}

function followupRows(id: number) {
  return getDatabase()
    .prepare(
      `SELECT checkpoint_kind, context_ref, fire_after
         FROM reflection_followups WHERE context_ref = ?`,
    )
    .all(`judgment:${id}`) as Array<{
    checkpoint_kind: string;
    context_ref: string;
    fire_after: string;
  }>;
}

describe("handlePushback — held_position (no evidence)", () => {
  it("holds the position: restates, does NOT re-run, does NOT soften", async () => {
    const jid = seedJudgment({ prose: "The pilot is at risk [1]." });
    const reRun = vi.fn<ReRunJudgmentFn>();

    const res = await handlePushback(jid, "are you sure?", {
      reRunJudgment: reRun,
      nowIso: NOW,
    });

    expect(res).toMatchObject({ kind: "held_position", judgmentId: jid });
    expect(res!.reply).toContain("Holding this position");
    expect(res!.reply).toContain("The pilot is at risk [1].");
    expect(reRun).not.toHaveBeenCalled();
    expect(concessionKind(jid)).toBe("held_position");
    // No ledger mutation on a hold.
    expect(getJudgmentById(jid)!.evidenceRefsJson).toBeNull();
    expect(followupRows(jid)).toHaveLength(0);
  });
});

describe("handlePushback — updated_with_evidence", () => {
  it("appends operator_message, re-runs, sets kind + triggering text, re-delivers, schedules recheck", async () => {
    const jid = seedJudgment({ posture: "at_risk" });
    const reRun = vi.fn<ReRunJudgmentFn>(async () => ({
      prose: "Updated: the pilot is recovering [1].",
    }));
    const reply = 'the customer said "we will renew" and signed on Tuesday';

    const res = await handlePushback(jid, reply, {
      reRunJudgment: reRun,
      nowIso: NOW,
    });

    expect(res).toMatchObject({
      kind: "updated_with_evidence",
      judgmentId: jid,
      triggeringEvidenceText: reply,
    });
    expect(res!.reply).toContain("Updating on your input");
    expect(res!.reply).toContain("Updated: the pilot is recovering [1].");

    // re-run got the judgment + the operator_message evidence ref.
    expect(reRun).toHaveBeenCalledTimes(1);
    const [passedJudgment, passedEvidence] = reRun.mock.calls[0];
    expect(passedJudgment.id).toBe(jid);
    expect(passedEvidence).toMatchObject({
      kind: "operator_message",
      excerpt: reply,
      retrieved_at: NOW,
    });

    expect(concessionKind(jid)).toBe("updated_with_evidence");

    // ledger now carries the operator_message ref.
    const ledger = JSON.parse(getJudgmentById(jid)!.evidenceRefsJson!);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "operator_message",
      retrieved_at: NOW,
    });

    // forward-looking (at_risk) → a verify_resolution recheck at now+72h.
    const fu = followupRows(jid);
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({
      checkpoint_kind: "verify_resolution",
      context_ref: `judgment:${jid}`,
      fire_after: PLUS_72H,
    });
  });

  it("does NOT schedule a recheck for a non-forward-looking judgment", async () => {
    const jid = seedJudgment({
      posture: "noted",
      subject: "weekly log",
      prose: "Logged for awareness.",
    });
    const reRun = vi.fn<ReRunJudgmentFn>(async () => ({ prose: "Revised." }));

    const res = await handlePushback(jid, "revenue dropped 30%", {
      reRunJudgment: reRun,
      nowIso: NOW,
    });

    expect(res!.kind).toBe("updated_with_evidence");
    expect(concessionKind(jid)).toBe("updated_with_evidence");
    expect(followupRows(jid)).toHaveLength(0);
  });
});

describe("handlePushback — deferred (evidence but no re-run wired)", () => {
  it("defers without faking a concession when reRunJudgment is absent (prod-dormant)", async () => {
    const jid = seedJudgment();

    const res = await handlePushback(jid, "revenue dropped 30%", {
      nowIso: NOW,
    }); // no reRunJudgment

    expect(res).toMatchObject({ kind: "deferred_no_rerun", judgmentId: jid });
    // NO concession recorded, NO ledger mutation, NO recheck.
    expect(concessionKind(jid)).toBeNull();
    expect(getJudgmentById(jid)!.evidenceRefsJson).toBeNull();
    expect(followupRows(jid)).toHaveLength(0);
  });
});

describe("handlePushback — invariants", () => {
  it("returns null when the judgment cannot be loaded", async () => {
    const res = await handlePushback(999999, "are you sure?", { nowIso: NOW });
    expect(res).toBeNull();
  });

  it("NEVER writes conceded_without_evidence on any live path", async () => {
    const held = seedJudgment();
    await handlePushback(held, "are you sure?", { nowIso: NOW });

    const updated = seedJudgment();
    await handlePushback(updated, "revenue dropped 30%", {
      reRunJudgment: async () => ({ prose: "x" }),
      nowIso: NOW,
    });

    const deferred = seedJudgment();
    await handlePushback(deferred, "revenue dropped 30%", { nowIso: NOW });

    const conceded = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM judgments
           WHERE concession_kind = 'conceded_without_evidence'`,
      )
      .get() as { n: number };
    expect(conceded.n).toBe(0);
  });

  it("does NOT record a concession if the re-run throws (no fabricated update)", async () => {
    const jid = seedJudgment();
    const reRun = vi.fn<ReRunJudgmentFn>(async () => {
      throw new Error("producer down");
    });

    await expect(
      handlePushback(jid, "revenue dropped 30%", {
        reRunJudgment: reRun,
        nowIso: NOW,
      }),
    ).rejects.toThrow("producer down");

    // concession_kind stays null — we appended evidence but never claimed update.
    expect(concessionKind(jid)).toBeNull();
  });

  it("appendEvidenceRef is idempotent on the same (kind, excerpt) — qa-W2", async () => {
    const jid = seedJudgment();
    const ref = {
      kind: "operator_message" as const,
      id: `operator:${NOW}`,
      excerpt: "revenue dropped 30%",
      retrieved_at: NOW,
    };
    // First throws on re-run (evidence appended, no concession); operator retries
    // with the SAME message → the duplicate must NOT be appended twice.
    appendEvidenceRef(jid, ref);
    const second = appendEvidenceRef(jid, { ...ref, id: `operator:later` });
    expect(second).toHaveLength(1);
    const ledger = JSON.parse(getJudgmentById(jid)!.evidenceRefsJson!);
    expect(ledger).toHaveLength(1);
  });
});
