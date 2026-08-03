import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  firstSentences,
  markJudgmentSurfaced,
  pickSyncJudgment,
  renderSyncPromptContext,
  renderSyncStrategicLine,
  type SyncJudgmentRow,
} from "./sync-surfacing.js";

/** Post-migration-v4 shape (base DDL + `surfaced_at`). */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE judgments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    briefing_id       TEXT NOT NULL,
    subject           TEXT NOT NULL,
    posture           TEXT NOT NULL,
    prose             TEXT NOT NULL,
    confidence        TEXT,
    created_at        TEXT NOT NULL,
    critic_trail_json TEXT,
    surfaced_at       TEXT
  )`);
  return db;
}

const APPROVED = JSON.stringify({ verdict: "approved" });
const UNFIXABLE = JSON.stringify({ verdict: "unfixable" });

interface SeedOpts {
  subject?: string;
  posture?: string;
  confidence?: string | null;
  createdAt?: string;
  trail?: string | null;
  surfacedAt?: string | null;
}

function seed(db: Database.Database, opts: SeedOpts = {}): number {
  const res = db
    .prepare(
      `INSERT INTO judgments
        (briefing_id, subject, posture, prose, confidence, created_at, critic_trail_json, surfaced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "brief-1",
      opts.subject ?? "PipeSong",
      opts.posture ?? "momentum",
      "El proyecto avanza. Segundo enunciado con detalle.",
      opts.confidence === undefined ? "green" : opts.confidence,
      opts.createdAt ?? "2999-01-01 06:00:00",
      opts.trail === undefined ? APPROVED : opts.trail,
      opts.surfacedAt ?? null,
    );
  return Number(res.lastInsertRowid);
}

describe("pickSyncJudgment", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("picks an approved green judgment from the 24h window", () => {
    const id = seed(db);
    expect(pickSyncJudgment(db)?.id).toBe(id);
  });

  it("returns null when nothing qualifies", () => {
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("excludes red and null confidence", () => {
    seed(db, { confidence: "red" });
    seed(db, { confidence: null });
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("excludes non-approved critic verdicts (unfixable, absent trail)", () => {
    seed(db, { trail: UNFIXABLE });
    seed(db, { trail: null });
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("excludes already-surfaced judgments", () => {
    seed(db, { surfacedAt: "2999-01-01 08:05:00" });
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("excludes judgments older than 24h", () => {
    seed(db, { createdAt: "2000-01-01 06:00:00" });
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("handles the producer's ISO-T created_at chronologically (no lexical 48h stretch)", () => {
    // In-window ISO row qualifies…
    const fresh = seed(db, { createdAt: new Date().toISOString() });
    expect(pickSyncJudgment(db)?.id).toBe(fresh);
    // …an ISO row ~30h old does NOT, even though a lexical compare against the
    // space-format threshold would admit it on same-calendar-date grounds.
    db.prepare("DELETE FROM judgments WHERE id = ?").run(fresh);
    const stale = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    seed(db, { createdAt: stale });
    expect(pickSyncJudgment(db)).toBeNull();
  });

  it("prefers highest_leverage over at_risk over momentum over noted", () => {
    seed(db, { posture: "noted" });
    seed(db, { posture: "momentum" });
    const atRisk = seed(db, { posture: "at_risk" });
    expect(pickSyncJudgment(db)?.id).toBe(atRisk);
    const hl = seed(db, { posture: "highest_leverage" });
    expect(pickSyncJudgment(db)?.id).toBe(hl);
  });

  it("breaks posture ties toward the newest row", () => {
    seed(db, { posture: "momentum" });
    const newer = seed(db, { posture: "momentum" });
    expect(pickSyncJudgment(db)?.id).toBe(newer);
  });

  it("sorts an unknown posture behind the known ones", () => {
    const weird = seed(db, { posture: "someday_new_posture" });
    const noted = seed(db, { posture: "noted" });
    expect(pickSyncJudgment(db)?.id).toBe(noted);
    db.prepare("DELETE FROM judgments WHERE id = ?").run(noted);
    expect(pickSyncJudgment(db)?.id).toBe(weird);
  });
});

describe("markJudgmentSurfaced", () => {
  it("stamps once; a second stamp is a no-op preserving the first timestamp", () => {
    const db = makeDb();
    const id = seed(db);
    expect(markJudgmentSurfaced(id, db)).toBe(true);
    const first = db
      .prepare("SELECT surfaced_at FROM judgments WHERE id = ?")
      .get(id) as { surfaced_at: string };
    expect(first.surfaced_at).toBeTruthy();
    expect(markJudgmentSurfaced(id, db)).toBe(false);
    const second = db
      .prepare("SELECT surfaced_at FROM judgments WHERE id = ?")
      .get(id) as { surfaced_at: string };
    expect(second.surfaced_at).toBe(first.surfaced_at);
  });

  it("returns false for a nonexistent judgment", () => {
    const db = makeDb();
    expect(markJudgmentSurfaced(9999, db)).toBe(false);
  });
});

describe("firstSentences", () => {
  it("passes short text through unchanged", () => {
    expect(firstSentences("Corto y claro.", 220)).toBe("Corto y claro.");
  });

  it("collapses whitespace", () => {
    expect(firstSentences("uno\n  dos\ttres", 220)).toBe("uno dos tres");
  });

  it("cuts at a non-fragmentary sentence boundary", () => {
    const text = `Primera frase completa. ${"x".repeat(300)}`;
    expect(firstSentences(text, 100)).toBe("Primera frase completa.");
  });

  it("prefers the ellipsis cut over a fragmentary lead sentence", () => {
    const text = `Sí. ${"x".repeat(300)}`;
    const out = firstSentences(text, 100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to an ellipsis cut when no usable boundary exists", () => {
    const text = "y".repeat(300);
    const out = firstSentences(text, 100);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(101);
  });
});

describe("renderers", () => {
  const row: SyncJudgmentRow = {
    id: 42,
    subject: "PipeSong",
    prose: "El proyecto avanza. Segundo enunciado con detalle.",
    confidence: "green",
    posture: "highest_leverage",
    critic_trail_json: APPROVED,
  };

  it("line carries the compass, confidence icon, and subject", () => {
    const line = renderSyncStrategicLine(row);
    expect(line).toContain("🧭 Lectura estratégica");
    expect(line).toContain("🟢");
    expect(line).toContain("PipeSong");
    expect(renderSyncStrategicLine({ ...row, confidence: "yellow" })).toContain(
      "🟡",
    );
  });

  it("prompt block carries subject, prose, and the weave instruction", () => {
    const block = renderSyncPromptContext(row);
    expect(block).toContain("LECTURA ESTRATÉGICA DE HOY");
    expect(block).toContain("PipeSong");
    expect(block).toContain(row.prose);
    expect(block).toContain("téjelo en la narrativa");
  });
});
