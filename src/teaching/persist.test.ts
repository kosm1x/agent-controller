import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase } from "../db/index.js";
import {
  createPlanWithUnits,
  getPlan,
  getUnit,
  listUnits,
  updateUnitStatus,
  setPlanCurrentUnit,
  setPlanStatus,
  upsertConcept,
  getConcept,
  listConcepts,
  startSession,
  endSession,
  getSession,
  recentQuizQuestions,
  findOpenSession,
} from "./persist.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("createPlanWithUnits", () => {
  it("creates plan + units transactionally", () => {
    const plan_id = createPlanWithUnits({
      topic: "React hooks",
      units: [
        {
          title: "useState",
          summary: "s",
          predicted_difficulties: ["stale closures"],
          prerequisites: [],
        },
        {
          title: "useEffect",
          summary: "e",
          predicted_difficulties: [],
          prerequisites: [0],
        },
      ],
    });
    const plan = getPlan(plan_id);
    expect(plan).not.toBeNull();
    expect(plan?.topic).toBe("React hooks");
    expect(plan?.status).toBe("active");
    expect(plan?.current_unit).toBe(0);

    const units = listUnits(plan_id);
    expect(units).toHaveLength(2);
    expect(units[0].status).toBe("ready");
    expect(units[1].status).toBe("locked");
    expect(units[0].predicted_difficulties).toEqual(["stale closures"]);
    expect(units[1].prerequisites).toEqual([0]);
  });

  it("cascade deletes units when plan deleted", async () => {
    const { getDatabase } = await import("../db/index.js");
    const db = getDatabase();
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    expect(getUnit(plan_id, 0)).not.toBeNull();
    db.prepare(`DELETE FROM learning_plans WHERE plan_id = ?`).run(plan_id);
    expect(getUnit(plan_id, 0)).toBeNull();
  });
});

describe("updateUnitStatus + setPlanCurrentUnit", () => {
  it("updates status + mastery_score", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    updateUnitStatus(plan_id, 0, "in_progress", 0.4);
    const u = getUnit(plan_id, 0);
    expect(u?.status).toBe("in_progress");
    expect(u?.mastery_score).toBe(0.4);
  });

  it("setPlanCurrentUnit updates pointer", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "a",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
        {
          title: "b",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [0],
        },
      ],
    });
    setPlanCurrentUnit(plan_id, 1);
    expect(getPlan(plan_id)?.current_unit).toBe(1);
  });

  it("setPlanStatus completes the plan", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    setPlanStatus(plan_id, "completed");
    expect(getPlan(plan_id)?.status).toBe("completed");
  });
});

describe("upsertConcept + learner_model", () => {
  it("insert new concept on first upsert", () => {
    const r = upsertConcept({
      concept: "React Hooks",
      mastery_estimate: 0.6,
      evidence_quote: "I use useState daily",
      session_id: "sess-1",
    });
    expect(r.is_new).toBe(true);
    expect(r.concept).toBe("react hook");
    const stored = getConcept("react hooks");
    expect(stored).not.toBeNull();
    expect(stored?.evidence_quotes).toHaveLength(1);
    expect(stored?.repetitions).toBe(1); // quality=3 (0.6*5=3) passes → rep=1
  });

  it("update on second upsert (not new)", () => {
    upsertConcept({
      concept: "x",
      mastery_estimate: 0.8,
      evidence_quote: "q1",
      session_id: "s1",
    });
    const r2 = upsertConcept({
      concept: "x",
      mastery_estimate: 0.8,
      evidence_quote: "q2",
      session_id: "s2",
    });
    expect(r2.is_new).toBe(false);
    const stored = getConcept("x");
    expect(stored?.evidence_quotes).toHaveLength(2);
    expect(stored?.repetitions).toBe(2);
  });

  it("normalizes concept keys so 'React' and 'react' merge", () => {
    upsertConcept({
      concept: "React",
      mastery_estimate: 0.5,
      evidence_quote: "q",
      session_id: "s1",
    });
    const r2 = upsertConcept({
      concept: "react",
      mastery_estimate: 0.5,
      evidence_quote: "q",
      session_id: "s2",
    });
    expect(r2.is_new).toBe(false);
  });

  it("evidence trimmed to recent 10 entries", () => {
    for (let i = 0; i < 15; i++) {
      upsertConcept({
        concept: "y",
        mastery_estimate: 0.6,
        evidence_quote: `quote ${i}`,
        session_id: `s${i}`,
      });
    }
    const stored = getConcept("y");
    expect(stored!.evidence_quotes.length).toBeLessThanOrEqual(10);
  });
});

describe("listConcepts filters", () => {
  it("due filter returns concepts where review_due_date <= now", () => {
    upsertConcept({
      concept: "past",
      mastery_estimate: 0.6,
      evidence_quote: "q",
      session_id: "s",
      now: 1000,
    });
    upsertConcept({
      concept: "future",
      mastery_estimate: 0.6,
      evidence_quote: "q",
      session_id: "s",
      now: 2_000_000_000,
    });
    const due = listConcepts({ filter: "due", limit: 10, now: 1_500_000_000 });
    const concepts = due.map((c) => c.concept);
    expect(concepts).toContain("past");
    expect(concepts).not.toContain("future");
  });

  it("all filter orders by last_seen DESC", () => {
    upsertConcept({
      concept: "older",
      mastery_estimate: 0.6,
      evidence_quote: "q",
      session_id: "s",
      now: 1000,
    });
    upsertConcept({
      concept: "newer",
      mastery_estimate: 0.6,
      evidence_quote: "q",
      session_id: "s",
      now: 2000,
    });
    const all = listConcepts({ filter: "all", limit: 10 });
    expect(all[0].concept).toBe("newer");
  });

  it("limit clamps to [1,50]", () => {
    upsertConcept({
      concept: "z",
      mastery_estimate: 0.6,
      evidence_quote: "q",
      session_id: "s",
    });
    const r = listConcepts({ filter: "all", limit: 999 });
    expect(r.length).toBeLessThanOrEqual(50);
  });
});

describe("sessions", () => {
  it("starts and ends a session", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    const session_id = startSession({
      plan_id,
      unit_index: 0,
      kind: "quiz",
    });
    expect(getSession(session_id)?.ended_at).toBeNull();
    endSession({
      session_id,
      mastery_delta: 0.3,
      summary: "s",
    });
    const ended = getSession(session_id);
    expect(ended?.ended_at).not.toBeNull();
    expect(ended?.mastery_delta).toBe(0.3);
  });

  it("findOpenSession returns the most recent un-ended session of a kind", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    // No open session yet
    expect(
      findOpenSession({ plan_id, unit_index: 0, kind: "explain_back" }),
    ).toBeNull();

    // Start two open explain_back sessions; most recent wins.
    const s1 = startSession({ plan_id, unit_index: 0, kind: "explain_back" });
    const s2 = startSession({ plan_id, unit_index: 0, kind: "explain_back" });
    expect(
      findOpenSession({ plan_id, unit_index: 0, kind: "explain_back" })
        ?.session_id,
    ).toBe(s2);

    // End s2 — s1 should now be returned.
    endSession({ session_id: s2, mastery_delta: null, summary: null });
    expect(
      findOpenSession({ plan_id, unit_index: 0, kind: "explain_back" })
        ?.session_id,
    ).toBe(s1);

    // End s1 — nothing open.
    endSession({ session_id: s1, mastery_delta: null, summary: null });
    expect(
      findOpenSession({ plan_id, unit_index: 0, kind: "explain_back" }),
    ).toBeNull();
  });

  it("recentQuizQuestions extracts questions from prior quiz sessions", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "u",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
      ],
    });
    const sid = startSession({ plan_id, unit_index: 0, kind: "quiz" });
    endSession({
      session_id: sid,
      mastery_delta: null,
      summary: JSON.stringify([
        { question: "Q1?", expected_answer: "A", difficulty: "medium" },
        { question: "Q2?", expected_answer: "B", difficulty: "medium" },
      ]),
    });
    const qs = recentQuizQuestions(plan_id, 0);
    expect(qs).toContain("Q1?");
    expect(qs).toContain("Q2?");
  });
});
