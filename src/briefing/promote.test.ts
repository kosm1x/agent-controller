/**
 * Briefing promote/discard tests (V8.1 Phase 8). Real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { BriefingSchema, type Briefing } from "./schema.js";
import {
  insertProposedBriefing,
  markBriefingDelivered,
  getProposedBriefing,
} from "./storage.js";
import {
  isExclusivelyBriefVerdict,
  resolveBriefingOnOperatorReply,
} from "./promote.js";

// Dynamic, not a hardcoded date: insertProposedBriefing() defaults expires_at
// to generated_at + 24h, so a fixed past date silently rots — every briefing
// auto-expires once the calendar passes generated_at + 1 day. The EXPIRES test
// overrides expires_at explicitly, so "now" here keeps every other briefing live.
const ISO = new Date().toISOString();
const SHA256 = "a".repeat(64);

function makeBriefing(): Briefing {
  return BriefingSchema.parse({
    briefing_id: crypto.randomUUID(),
    surface: "morning",
    generated_at: ISO,
    source_window: {
      cursor_start_event_id: 1,
      cursor_end_event_id: 2,
      wall_start: ISO,
      wall_end: ISO,
    },
    active_objective_ids: [],
    self_defining_grounding: [],
    general_events_used: [],
    judgments: [
      {
        signal_id: crypto.randomUUID(),
        kind: "stalled_task",
        subject: "t-1",
        posture: "noted",
        confidence: "green",
        confidence_reason: "clear evidence here",
        why: "surfaced for awareness with a concrete documented reason",
        evidence_indices: [0],
      },
    ],
    verified_against: [
      {
        type: "sqlite",
        table: "tasks",
        query_sha: SHA256,
        row_count: 1,
        queried_at: ISO,
      },
    ],
    sample_n: 1,
    concerns: [],
    critic_verdict: "pass",
  });
}

/** Insert + deliver a briefing, with an optional explicit expiry. */
function deliverNew(expiresAt?: string): string {
  const b = makeBriefing();
  insertProposedBriefing(b, expiresAt ? { expiresAt } : {});
  markBriefingDelivered(b.briefing_id);
  return b.briefing_id;
}

function triagePolicy(surface: string) {
  return getDatabase()
    .prepare(
      `SELECT promote_count, discard_count, last_outcome
         FROM triage_policies WHERE surface = ?`,
    )
    .get(surface) as
    | { promote_count: number; discard_count: number; last_outcome: string }
    | undefined;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("resolveBriefingOnOperatorReply", () => {
  it("returns null when no delivered briefing is pending", async () => {
    expect(await resolveBriefingOnOperatorReply("hola")).toBeNull();
  });

  it("does NOT resolve an undelivered pending briefing", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b); // persisted but never delivered
    expect(await resolveBriefingOnOperatorReply("hola")).toBeNull();
    expect(getProposedBriefing(b.briefing_id)!.status).toBe("pending");
  });

  it("PROMOTES on an explicit accept verdict and bumps the triage counter", async () => {
    const id = deliverNew();
    const result = await resolveBriefingOnOperatorReply("sirve");
    expect(result).toMatchObject({ briefingId: id, resolution: "promoted" });
    expect(getProposedBriefing(id)!.status).toBe("promoted");
    expect(triagePolicy("morning")).toMatchObject({
      promote_count: 1,
      discard_count: 0,
      last_outcome: "promoted",
    });
  });

  it("LEAVES PENDING an unrelated message — engagement is not endorsement", async () => {
    // The 2026-07-10 root cause: `resolveBriefingOnOperatorReply` fires on EVERY
    // inbound owner message, so texting Jarvis about another project used to
    // promote that morning's brief. Acceptance must be an explicit act.
    const id = deliverNew();
    const result = await resolveBriefingOnOperatorReply(
      "Hoy nos concentramos en subir el sitio de EurekaMS a eurekams.net",
    );
    expect(result).toBeNull();
    expect(getProposedBriefing(id)!.status).toBe("pending");
    expect(triagePolicy("morning")).toBeUndefined();
  });

  it("LEAVES PENDING an unrelated instruction that the LLM would call a discard", async () => {
    // Verbatim: the message that falsely DISCARDED the 2026-07-09 brief. It is
    // about the DENUE project, not the brief. No judgments here, so no LLM runs
    // at all — but it must not match DISCARD_RE either.
    const id = deliverNew();
    const result = await resolveBriefingOnOperatorReply(
      "Dejamos para después el Denue americano. No es urgente ni estratégico. Cierra ese tema.",
    );
    expect(result).toBeNull();
    expect(getProposedBriefing(id)!.status).toBe("pending");
  });

  it("LEAVES PENDING everyday Spanish that merely CONTAINS a verdict-ish word (audit C1)", async () => {
    // A substring allow-list is not enough: `resolveBriefingOnOperatorReply`
    // sees EVERY owner message, so any token that is also an ordinary word
    // resolves the brief from an unrelated instruction. The verdict must be the
    // WHOLE message. Each of these promoted the brief before the anchoring fix.
    for (const text of [
      "dale prioridad al tema del CRM hoy",
      "listo, ya subí el sitio",
      "ok, mando el correo",
      "confirmo la reunión de las 3",
      "todo listo por aquí",
      "sirve mucho para el CRM que armamos",
      "¿te sirve el reporte?",
      "no estoy de acuerdo con el punto 2",
      // A QUESTION is not a verdict. Punctuation-stripping would otherwise
      // reduce these to the bare accept token.
      "¿sirve?",
      "sirve?",
      "¿útil?",
    ]) {
      const id = deliverNew();
      expect(await resolveBriefingOnOperatorReply(text), text).toBeNull();
      expect(getProposedBriefing(id)!.status, text).toBe("pending");
    }
  });

  it("ACCEPTS the accented 'útil' as well as bare/punctuated verdicts (audit W2)", async () => {
    // Without the `u` flag, `\b[uú]til` never fired on a leading accented `ú`,
    // so the CORRECTLY spelled word was silently dropped.
    for (const text of [
      "útil",
      "util",
      "sirve.",
      "¡sirve!",
      "sirve, gracias",
      "sí sirve",
      "es útil",
    ]) {
      const id = deliverNew();
      expect(await resolveBriefingOnOperatorReply(text), text).toMatchObject({
        resolution: "promoted",
      });
      expect(getProposedBriefing(id)!.status, text).toBe("promoted");
    }
  });

  it("DISCARDS a negated accept token ('no sirve') rather than promoting it", async () => {
    // DISCARD_RE is tested BEFORE ACCEPT_RE precisely so `\bsirve\b` cannot
    // capture "no sirve" / "no me sirve" / "no es útil".
    for (const text of ["no sirve", "no me sirve", "no es útil"]) {
      const id = deliverNew();
      const result = await resolveBriefingOnOperatorReply(text);
      expect(result, text).toMatchObject({ resolution: "discarded" });
      expect(getProposedBriefing(id)!.status, text).toBe("discarded");
    }
  });

  it("DISCARDS on an explicit rejection phrase", async () => {
    const id = deliverNew();
    const result = await resolveBriefingOnOperatorReply("descartar");
    expect(result).toMatchObject({ briefingId: id, resolution: "discarded" });
    expect(getProposedBriefing(id)!.status).toBe("discarded");
    expect(triagePolicy("morning")).toMatchObject({
      promote_count: 0,
      discard_count: 1,
    });
  });

  it("carries a deterministic operator ack on binary outcomes, none on expiry", async () => {
    // 2026-07-11 incident: the old "router sends nothing for binary outcomes"
    // design left the operator in total silence after "sirve" (the parallel
    // chat task answered with an empty STATUS: DONE). The ruling itself must
    // confirm. Expiry stays reply-less — it fires on ANY owner message past
    // the TTL, where an interjection would be out-of-context noise.
    deliverNew();
    expect((await resolveBriefingOnOperatorReply("sirve"))!.reply).toBe(
      "✓ Brief conservado.",
    );
    deliverNew();
    expect((await resolveBriefingOnOperatorReply("descartar"))!.reply).toBe(
      "🗑️ Brief descartado.",
    );
    deliverNew("2020-01-01T00:00:00.000Z");
    expect(
      (await resolveBriefingOnOperatorReply("sirve"))!.reply,
    ).toBeUndefined();
  });

  it("isExclusivelyBriefVerdict: pure rulings swallow, imperatives and non-verdicts don't (qa-audit W1)", () => {
    // Pure rulings — meaningless except as a verdict on the brief: the
    // router may consume the message.
    for (const text of [
      "sirve",
      "útil",
      "sí sirve",
      "no sirve",
      "no me interesa",
      "¡Sirve!",
    ]) {
      expect(isExclusivelyBriefVerdict(text), text).toBe(true);
    }
    // Imperative-shaped verdicts double as instructions about prior context
    // ("archívalo" = archive that email) — still verdicts, never swallowed.
    for (const text of ["descártalo", "archívalo", "skip", "descartar"]) {
      expect(isExclusivelyBriefVerdict(text), text).toBe(false);
    }
    // Non-verdicts.
    for (const text of ["¿sirve?", "dale prioridad al CRM", "hola"]) {
      expect(isExclusivelyBriefVerdict(text), text).toBe(false);
    }
  });

  it("LEAVES PENDING a reply that merely defers ('lo veo más tarde')", async () => {
    // audit W5 — "más tarde" / "no ahora" are engagement, not rejection. They
    // are ALSO not an endorsement: since 2026-07-10 they leave the brief pending
    // rather than promoting it (was: `resolution: "promoted"`).
    const id = deliverNew();
    const result = await resolveBriefingOnOperatorReply(
      "gracias, lo veo más tarde con calma",
    );
    expect(result).toBeNull();
    expect(getProposedBriefing(id)!.status).toBe("pending");
  });

  it("EXPIRES a delivered briefing whose expiry has passed, regardless of reply", async () => {
    const id = deliverNew("2020-01-01T00:00:00.000Z"); // long past
    const result = await resolveBriefingOnOperatorReply("gracias");
    expect(result).toMatchObject({ briefingId: id, resolution: "expired" });
    expect(getProposedBriefing(id)!.status).toBe("expired");
    // An expiry is not a promote/discard outcome — no triage row written.
    expect(triagePolicy("morning")).toBeUndefined();
  });

  it("is a no-op on the second reply — the briefing is already resolved", async () => {
    deliverNew();
    expect((await resolveBriefingOnOperatorReply("sirve"))!.resolution).toBe(
      "promoted",
    );
    expect(await resolveBriefingOnOperatorReply("otra cosa")).toBeNull();
  });
});

// ── V8.2 §13 concession path (judgment-bearing briefs) ────────────────────────

/** Attach a judgment to a briefing so the §13 path engages. */
function addJudgment(
  briefingId: string,
  posture = "at_risk",
  prose = "The pilot is at risk [1].",
): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(briefingId, "CRM pilot", posture, prose, ISO);
  return Number(info.lastInsertRowid);
}

describe("resolveBriefingOnOperatorReply — §13 concession path", () => {
  it("DORMANT: a brief with no judgments never invokes the classifier", async () => {
    deliverNew();
    const classify = vi.fn(); // would throw if called with no impl
    const result = await resolveBriefingOnOperatorReply("sirve", {
      classify: classify as never,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resolution: "promoted" });
  });

  it("pushback (no evidence) HOLDS the position and keeps the brief pending", async () => {
    const id = deliverNew();
    const jid = addJudgment(id);
    const result = await resolveBriefingOnOperatorReply("are you sure?", {
      classify: async () => ({
        cls: "pushback",
        judgmentId: jid,
        rationale: "disputes",
        error: false,
      }),
      reRunJudgment: async () => ({ prose: "should not be called" }),
      nowIso: ISO,
    });
    expect(result).toMatchObject({
      briefingId: id,
      resolution: "held_position",
    });
    expect(result!.reply).toContain("Holding this position");
    // The brief stays pending — the operator is still in dialogue.
    expect(getProposedBriefing(id)!.status).toBe("pending");
  });

  it("pushback (with evidence) UPDATES via the injected re-run and re-delivers", async () => {
    const id = deliverNew();
    const jid = addJudgment(id);
    const result = await resolveBriefingOnOperatorReply("revenue dropped 30%", {
      classify: async () => ({
        cls: "pushback",
        judgmentId: jid,
        rationale: "evidence",
        error: false,
      }),
      reRunJudgment: async () => ({ prose: "Revised: recovering [1]." }),
      nowIso: ISO,
    });
    expect(result).toMatchObject({ resolution: "updated_with_evidence" });
    expect(result!.reply).toContain("Updating on your input");
    expect(getProposedBriefing(id)!.status).toBe("pending");
  });

  it("a classified promote CANNOT resolve a brief without an explicit operator verdict", async () => {
    // The classifier's opinion is advisory, never authoritative. This is the
    // exact path that promoted 28/28 briefs on unrelated messages: an LLM said
    // "engaged" and the brief was booked as accepted.
    const id = deliverNew();
    addJudgment(id);
    const result = await resolveBriefingOnOperatorReply("gracias", {
      classify: async () => ({
        cls: "promote",
        judgmentId: null,
        rationale: "engaged",
        error: false,
      }),
    });
    expect(result).toBeNull();
    expect(getProposedBriefing(id)!.status).toBe("pending");
  });

  it("an explicit accept on a judgment-bearing brief delegates to the V8.1 promote", async () => {
    const id = deliverNew();
    addJudgment(id);
    const result = await resolveBriefingOnOperatorReply("sirve", {
      classify: async () => ({
        cls: "promote",
        judgmentId: null,
        rationale: "engaged",
        error: false,
      }),
    });
    expect(result).toMatchObject({ resolution: "promoted" });
    expect(getProposedBriefing(id)!.status).toBe("promoted");
  });

  it("the classifier may ESCALATE an accept to a discard, but never the reverse", async () => {
    // Escalate: operator said "sirve" but the classifier read a rejection.
    const a = deliverNew();
    addJudgment(a);
    expect(
      await resolveBriefingOnOperatorReply("sirve", {
        classify: async () => ({
          cls: "discard",
          judgmentId: null,
          rationale: "",
          error: false,
        }),
      }),
    ).toMatchObject({ resolution: "discarded" });

    // Never the reverse: an explicit "descarta" cannot be promoted by an LLM.
    const b = deliverNew();
    addJudgment(b);
    expect(
      await resolveBriefingOnOperatorReply("descarta", {
        classify: async () => ({
          cls: "promote",
          judgmentId: null,
          rationale: "",
          error: false,
        }),
      }),
    ).toMatchObject({ resolution: "discarded" });
    expect(getProposedBriefing(b)!.status).toBe("discarded");
  });

  it("a classifier failure (cls=null) falls back to the legacy DISCARD_RE", async () => {
    const id = deliverNew();
    addJudgment(id);
    const result = await resolveBriefingOnOperatorReply("descártalo", {
      classify: async () => ({
        cls: null,
        judgmentId: null,
        rationale: "",
        error: true,
      }),
    });
    expect(result).toMatchObject({ resolution: "discarded" });
    expect(getProposedBriefing(id)!.status).toBe("discarded");
  });
});
