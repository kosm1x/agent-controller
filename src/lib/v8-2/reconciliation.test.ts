/**
 * V8.2 Phase 0 — reconciliation constants + resolvers (spec §5/§6/§7).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the embedder import hermetic — we only assert the dim constant.
vi.mock("../../inference/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
}));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { EMBED_DIMS } from "../../memory/embeddings.js";
import {
  EVIDENCE_KINDS,
  TOOL_GUIDANCE,
  POSTURES,
  CONCESSION_KINDS,
  validateToolGuidance,
  fetchEvidenceExcerpt,
} from "./reconciliation.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("evidence_kind reconciliation (§6)", () => {
  it("includes V8.1's own detection substrate (the R1 gap)", () => {
    for (const k of ["general_event", "recurring_blocker", "cohort_member"]) {
      expect(EVIDENCE_KINDS).toContain(k);
    }
  });
});

describe("tool_guidance reconciliation (§7)", () => {
  // Regression guard (audit W1): scan the actual tool source for `name: "..."`
  // definitions and assert every TOOL_GUIDANCE value resolves to one. This
  // catches a tool RENAME — the failure mode a hand-authored name set could
  // not — not just an accidental enum edit.
  function registeredToolNamesFromSource(): Set<string> {
    const root = join(process.cwd(), "src", "tools");
    const names = new Set<string>();
    const entries = readdirSync(root, { recursive: true }) as string[];
    for (const rel of entries) {
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      const text = readFileSync(join(root, rel), "utf-8");
      for (const m of text.matchAll(/name:\s*"([a-z0-9_]+)"/g)) {
        names.add(m[1]);
      }
    }
    return names;
  }

  it("every tool_guidance value resolves to a real registered tool", () => {
    const names = registeredToolNamesFromSource();
    expect(names.size).toBeGreaterThan(20); // sanity: scan found the registry
    const result = validateToolGuidance(names);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports names that do not resolve (validator logic)", () => {
    const result = validateToolGuidance(new Set(["crm_query"])); // 5 missing
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("northstar_sync");
    expect(result.missing).not.toContain("crm_query");
  });

  it("accepts any iterable, not just a Set", () => {
    const arr = [
      "crm_query",
      "intel_query",
      "memory_search",
      "memory_kg_query",
      "jarvis_file_search",
      "northstar_sync",
    ];
    expect(validateToolGuidance(arr).ok).toBe(true);
  });

  it("does NOT regress to R1's fictional names", () => {
    // R1's tool_guidance enum was tasks_query/northstar_read/kb_search/...
    for (const fictional of [
      "tasks_query",
      "northstar_read",
      "kb_search",
      "metric_lookup",
    ]) {
      expect(TOOL_GUIDANCE).not.toContain(fictional);
    }
  });
});

describe("posture / concession vocab (§6)", () => {
  it("uses the canonical V8.2 'momentum', not V8.1 'has_momentum'", () => {
    expect(POSTURES).toContain("momentum");
    expect(POSTURES).not.toContain("has_momentum");
  });
  it("concession kinds are the three §13 outcomes", () => {
    expect([...CONCESSION_KINDS].sort()).toEqual(
      [
        "conceded_without_evidence",
        "held_position",
        "updated_with_evidence",
      ].sort(),
    );
  });
});

describe("fetchEvidenceExcerpt — resolves to a live V8.1 row end-to-end (§5 item 3)", () => {
  const NOW = "2026-05-31T08:00:00.000Z";

  it("resolves a general_event by event_id with temporal context", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO general_events (event_id, level, title, summary, start_at, end_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      "ge-1",
      "general",
      "CRM pilot",
      "3 open blockers",
      "2026-05-01T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    );
    const ev = fetchEvidenceExcerpt("general_event", "ge-1", {
      db,
      nowIso: NOW,
    });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe("general_event");
    expect(ev!.id).toBe("ge-1");
    expect(ev!.excerpt).toContain("CRM pilot");
    expect(ev!.excerpt).toContain("3 open blockers");
    expect(ev!.excerpt).toContain("last_seen=2026-05-20T00:00:00.000Z");
    expect(ev!.retrieved_at).toBe(NOW);
  });

  it("falls back to start_at when general_event has no end_at", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO general_events (event_id, level, title, summary, start_at)
       VALUES (?,?,?,?,?)`,
    ).run(
      "ge-2",
      "lifetime",
      "Career arc",
      "ongoing",
      "2026-01-01T00:00:00.000Z",
    );
    const ev = fetchEvidenceExcerpt("general_event", "ge-2", {
      db,
      nowIso: NOW,
    });
    expect(ev!.excerpt).toContain("last_seen=2026-01-01T00:00:00.000Z");
  });

  it("resolves a recurring_blocker by signature", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO recurring_blockers
         (blocker_signature, first_seen_at, last_seen_at, task_count, task_ids_json)
       VALUES (?,?,?,?,?)`,
    ).run(
      "whatsapp-disconnect",
      "2026-05-10T00:00:00.000Z",
      "2026-05-29T00:00:00.000Z",
      4,
      "[]",
    );
    const ev = fetchEvidenceExcerpt(
      "recurring_blocker",
      "whatsapp-disconnect",
      {
        db,
        nowIso: NOW,
      },
    );
    expect(ev!.excerpt).toContain("whatsapp-disconnect");
    expect(ev!.excerpt).toContain("seen 4×");
    expect(ev!.excerpt).toContain("last_seen=2026-05-29T00:00:00.000Z");
  });

  it("resolves a cohort_member by member_id", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO self_defining_cohort (member_id, member_kind, label, source_ref, salience)
       VALUES (?,?,?,?,?)`,
    ).run("project:crm", "project", "CRM Azteca", "ref", 0.8);
    const ev = fetchEvidenceExcerpt("cohort_member", "project:crm", {
      db,
      nowIso: NOW,
    });
    expect(ev!.excerpt).toContain("project: CRM Azteca");
    expect(ev!.excerpt).toContain("salience=0.8");
  });

  it("returns null when the id does not resolve (→ §9 marks unresolved)", () => {
    const db = getDatabase();
    expect(fetchEvidenceExcerpt("general_event", "nope", { db })).toBeNull();
    expect(
      fetchEvidenceExcerpt("recurring_blocker", "nope", { db }),
    ).toBeNull();
    expect(fetchEvidenceExcerpt("cohort_member", "nope", { db })).toBeNull();
  });
});

describe("embedder path (§5 item 5)", () => {
  it("is the 1536-d Gemini path the Phase 3 diversity gate targets", () => {
    expect(EMBED_DIMS).toBe(1536);
  });
});
