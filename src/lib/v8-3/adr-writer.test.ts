/**
 * V8.3 Phase 4 — ADR lazy-render tests.
 *
 * The renderer is PURE (row + events + capability → markdown), so the §13
 * acceptance ("10 rows → well-formed ADRs") and the edge cases run against
 * constructed `DecisionRow` literals with no DB. Only `renderDecisionAdrById`
 * exercises the store readers against a real in-memory DB (foreign_keys = ON,
 * so a parent capability row is seeded first).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { appendDecisionEvent, insertDecision } from "./decisions-store.js";
import {
  adrFilename,
  renderDecisionAdr,
  renderDecisionAdrById,
  renderReversalProcedure,
  statusLabel,
} from "./adr-writer.js";
import type { ReversalOp } from "./reversal.js";
import type { AutonomyLevel, DecisionRow, DecisionStatus } from "./types.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeDecision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: 1,
    capability: "task_edit",
    judgment_id: null,
    autonomy_level: 1,
    status: "committed",
    capability_token_json: JSON.stringify({ capability: "task_edit" }),
    payload_json: JSON.stringify({
      summary: "extend Q3 deadline",
      task_id: 42,
    }),
    pre_state_json: null,
    reversal_op_json: null,
    pheropath_signal: null,
    proposed_at: "2026-06-27T10:00:00.000Z",
    decided_at: "2026-06-27T10:00:05.000Z",
    reverted_at: null,
    superseded_by: null,
    supersedes: null,
    operator_override_kind: null,
    thread_id: "thread-abc",
    ...over,
  };
}

const SQL_INVERSE: ReversalOp = {
  kind: "sql_inverse",
  tables: ["tasks"],
  steps: [
    { action: "restore", table: "tasks", pk: { id: 42 }, row: { id: 42 } },
  ],
  fingerprint: "abc123",
};
const COMPENSATING: ReversalOp = {
  kind: "compensating",
  proposal: "send a follow-up email retracting the prior one",
  autoExecutable: false,
};
const IRREVERSIBLE: ReversalOp = {
  kind: "irreversible",
  reason: "the email was already delivered",
};
const DEFERRED: ReversalOp = {
  kind: "deferred",
  strategy: "delete_inverse",
  note: "replay requires the tool layer (later phase)",
};

const REVERSAL_CYCLE: (ReversalOp | null)[] = [
  null,
  SQL_INVERSE,
  COMPENSATING,
  IRREVERSIBLE,
  DEFERRED,
];
const STATUS_CYCLE: DecisionStatus[] = [
  "pending",
  "committed",
  "reverted",
  "vetoed",
  "interrupted",
];
const SECTIONS = [
  "## Context",
  "## Decision",
  "## Confidence and basis",
  "## Consequences",
  "## Reversal procedure",
  "## Cross-references",
];

// ── §13 acceptance ─────────────────────────────────────────────────────────────

describe("renderDecisionAdr — §13 acceptance (10 rows → well-formed ADRs)", () => {
  it("renders 10 varied decisions, each with frontmatter + all six sections", () => {
    for (let i = 1; i <= 10; i++) {
      const op = REVERSAL_CYCLE[i % REVERSAL_CYCLE.length];
      const d = makeDecision({
        id: i,
        autonomy_level: (i % 6) as AutonomyLevel,
        status: STATUS_CYCLE[i % STATUS_CYCLE.length],
        judgment_id: i % 2 === 0 ? 100 + i : null,
        reversal_op_json: op ? JSON.stringify(op) : null,
        superseded_by: i === 7 ? 8 : null,
        pheropath_signal: i % 3 === 0 ? "SAFE" : null,
      });
      const md = renderDecisionAdr({ decision: d, events: [] });

      // Frontmatter is a delimited block at the very top.
      expect(md.startsWith("---\n")).toBe(true);
      expect(md.indexOf("\n---", 4)).toBeGreaterThan(0);
      // Title with the id, and every §9 section present.
      expect(md).toContain(`# ADR ${i}:`);
      for (const h of SECTIONS) expect(md).toContain(h);
    }
  });
});

// ── frontmatter ────────────────────────────────────────────────────────────────

describe("renderDecisionAdr — MADR frontmatter", () => {
  function frontmatter(md: string): Record<string, string> {
    const end = md.indexOf("\n---", 4);
    const block = md.slice(4, end);
    const out: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return out;
  }

  it("carries every §9 frontmatter key with correct values", () => {
    const d = makeDecision({
      id: 42,
      capability: "task_edit",
      autonomy_level: 2,
      judgment_id: 17,
      pheropath_signal: "TODO",
      reversal_op_json: JSON.stringify(SQL_INVERSE),
      operator_override_kind: "accepted",
    });
    const fm = frontmatter(renderDecisionAdr({ decision: d, events: [] }));
    expect(fm.id).toBe("42");
    expect(fm.date).toBe("2026-06-27");
    expect(fm.capability).toBe("task_edit");
    expect(fm.autonomy_level).toBe("2");
    expect(fm.status).toBe("Committed");
    expect(fm.supersedes).toBe("null");
    expect(fm.superseded_by).toBe("null");
    expect(fm.operator_override).toBe("accepted");
    expect(fm.reversal_procedure).toBe("sql_inverse");
    expect(fm.judgment_id).toBe("17");
    expect(fm.pheropath_signal).toBe("TODO");
  });

  it("renders null pointers/signals as the literal 'null' and override as 'none'", () => {
    const fm = frontmatter(
      renderDecisionAdr({ decision: makeDecision(), events: [] }),
    );
    expect(fm.judgment_id).toBe("null");
    expect(fm.pheropath_signal).toBe("null");
    expect(fm.operator_override).toBe("none");
    expect(fm.reversal_procedure).toBe("none");
  });
});

// ── status lifecycle (§9) ───────────────────────────────────────────────────────

describe("statusLabel — §9 lifecycle", () => {
  it("maps each DB status to its human label", () => {
    expect(statusLabel(makeDecision({ status: "pending" }))).toBe("Proposed");
    expect(statusLabel(makeDecision({ status: "committed" }))).toBe(
      "Committed",
    );
    expect(statusLabel(makeDecision({ status: "reverted" }))).toBe("Reverted");
    expect(statusLabel(makeDecision({ status: "vetoed" }))).toBe("Vetoed");
    expect(statusLabel(makeDecision({ status: "interrupted" }))).toBe(
      "Interrupted",
    );
  });

  it("a superseded_by pointer overrides the raw status (bidirectional, §9)", () => {
    // status is still 'committed' in the DB, but the pointer makes it Superseded.
    const d = makeDecision({ status: "committed", superseded_by: 8 });
    expect(statusLabel(d)).toBe("Superseded by 8");
    const md = renderDecisionAdr({ decision: d, events: [] });
    expect(md).toContain("# ADR 1: task_edit — Superseded by 8");
    expect(md).toContain("- Superseded by: decision 8");
  });
});

// ── reversal procedure (one line per §7 kind) ───────────────────────────────────

describe("renderReversalProcedure — per §7 ReversalOp kind", () => {
  it("sql_inverse → automatic, with step + table count", () => {
    expect(renderReversalProcedure(SQL_INVERSE)).toContain("Automatic");
    expect(renderReversalProcedure(SQL_INVERSE)).toContain("1 step(s)");
    expect(renderReversalProcedure(SQL_INVERSE)).toContain("tasks");
  });
  it("compensating → operator-confirmed, PROPOSED never auto-executed", () => {
    const s = renderReversalProcedure(COMPENSATING);
    expect(s).toContain("Operator-confirmed");
    expect(s).toContain("PROPOSED");
    expect(s).toContain("follow-up email");
  });
  it("irreversible → states the reason", () => {
    expect(renderReversalProcedure(IRREVERSIBLE)).toBe(
      "Irreversible — the email was already delivered",
    );
  });
  it("deferred → names the strategy and note", () => {
    expect(renderReversalProcedure(DEFERRED)).toContain(
      "Deferred (delete_inverse)",
    );
  });
  it("null → none recorded", () => {
    expect(renderReversalProcedure(null)).toBe("None recorded.");
  });
  it("a malformed reversal_op_json renders as none (defensive parse)", () => {
    const d = makeDecision({ reversal_op_json: "{not json" });
    expect(renderDecisionAdr({ decision: d, events: [] })).toContain(
      "None recorded.",
    );
  });

  it("an unknown/crafted reversal kind is rejected (no frontmatter injection)", () => {
    // A kind outside the §7 set must NOT reach the raw `reversal_procedure:`
    // frontmatter line — it degrades to none, not the attacker-controlled string.
    const d = makeDecision({
      reversal_op_json: JSON.stringify({ kind: "x\ninjected: pwned" }),
    });
    const md = renderDecisionAdr({ decision: d, events: [] });
    expect(md).toContain("reversal_procedure: none");
    expect(md).not.toContain("injected: pwned");
    expect(md).toContain("None recorded.");
  });
});

// ── content sections ────────────────────────────────────────────────────────────

describe("renderDecisionAdr — section content", () => {
  it("renders the linked judgment when present, else the no-judgment note", () => {
    const linked = renderDecisionAdr({
      decision: makeDecision({ judgment_id: 17 }),
      events: [],
    });
    expect(linked).toContain("Linked V8.2 judgment: #17");
    expect(linked).toContain("Grounded in V8.2 judgment #17");

    const unlinked = renderDecisionAdr({
      decision: makeDecision(),
      events: [],
    });
    expect(unlinked).toContain("No linked V8.2 judgment");
    expect(unlinked).toContain("did not pass through the consent layer");
  });

  it("includes the payload as a JSON code block and the blast radius from the capability row", () => {
    const md = renderDecisionAdr({
      decision: makeDecision(),
      events: [],
      capability: {
        capability: "task_edit",
        blast_radius: "persistent",
      } as never,
    });
    expect(md).toContain("```json");
    expect(md).toContain('"summary": "extend Q3 deadline"');
    expect(md).toContain("- Blast radius: persistent");
  });

  it("falls back gracefully when the capability row is absent", () => {
    const md = renderDecisionAdr({ decision: makeDecision(), events: [] });
    expect(md).toContain("- Blast radius: unknown (capability not seeded)");
  });

  it("renders the event timeline in order, or a placeholder when empty", () => {
    const withEvents = renderDecisionAdr({
      decision: makeDecision(),
      events: [
        {
          id: 1,
          decision_id: 1,
          sequence_no: 1,
          event_kind: "proposed",
          payload_json: null,
          occurred_at: "2026-06-27T10:00:00.000Z",
          parent_event_seq: null,
        },
        {
          id: 2,
          decision_id: 1,
          sequence_no: 2,
          event_kind: "executed",
          payload_json: null,
          occurred_at: "2026-06-27T10:00:05.000Z",
          parent_event_seq: 1,
        },
      ],
    });
    expect(withEvents).toContain("seq 1: `proposed`");
    expect(withEvents).toContain("seq 2: `executed`");
    expect(withEvents.indexOf("seq 1")).toBeLessThan(
      withEvents.indexOf("seq 2"),
    );

    expect(
      renderDecisionAdr({ decision: makeDecision(), events: [] }),
    ).toContain("(no events recorded)");
  });

  it("renders the PheroPath signal line only when present", () => {
    expect(
      renderDecisionAdr({
        decision: makeDecision({ pheropath_signal: "DANGER" }),
        events: [],
      }),
    ).toContain("PheroPath signal: DANGER");
    expect(
      renderDecisionAdr({ decision: makeDecision(), events: [] }),
    ).not.toContain("PheroPath signal:");
  });
});

// ── filename ────────────────────────────────────────────────────────────────────

describe("adrFilename — logs/decisions/<id>-<capability>-<slug>.md (§9)", () => {
  it("slugs a payload descriptor", () => {
    expect(adrFilename(makeDecision({ id: 5 }))).toBe(
      "logs/decisions/5-task-edit-extend-q3-deadline.md",
    );
  });
  it("falls back to 'decision' when the payload has no descriptor", () => {
    expect(
      adrFilename(
        makeDecision({ id: 9, payload_json: JSON.stringify({ x: 1 }) }),
      ),
    ).toBe("logs/decisions/9-task-edit-decision.md");
  });
  it("slugs a capability with non-alnum characters", () => {
    expect(
      adrFilename(
        makeDecision({
          id: 3,
          capability: "jarvis_files.batch_write",
          payload_json: "{}",
        }),
      ),
    ).toBe("logs/decisions/3-jarvis-files-batch-write-decision.md");
  });

  it("neutralizes a path-traversal / punctuation-only descriptor (no escape)", () => {
    // The non-alnum whitelist strips every '/' and '.', so '..' and a leading
    // '/' cannot survive into the path, and a punctuation-only descriptor
    // collapses to the stable 'decision' fallback.
    const traversal = adrFilename(
      makeDecision({
        id: 4,
        capability: "task_edit",
        payload_json: JSON.stringify({ summary: "../../etc/passwd" }),
      }),
    );
    expect(traversal).toBe("logs/decisions/4-task-edit-etc-passwd.md");
    expect(traversal).not.toContain("..");

    expect(
      adrFilename(
        makeDecision({
          id: 5,
          capability: "task_edit",
          payload_json: JSON.stringify({ summary: "///...///" }),
        }),
      ),
    ).toBe("logs/decisions/5-task-edit-decision.md");
  });
});

// ── DB round-trip (renderDecisionAdrById) ───────────────────────────────────────

describe("renderDecisionAdrById — fetch + render", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => closeDatabase());

  function seedCapability(capability: string): void {
    getDatabase()
      .prepare(
        `INSERT INTO capability_autonomy
           (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
            blast_radius, reversible_default, override_window_start_at, description)
         VALUES (?, 1, '{}', '{}', 0, 'session', 1, datetime('now'), 'seed')`,
      )
      .run(capability);
  }

  it("renders a persisted decision with its events", () => {
    seedCapability("task_edit");
    const id = insertDecision({
      capability: "task_edit",
      judgmentId: null,
      autonomyLevel: 1,
      status: "committed",
      capabilityToken: { capability: "task_edit" },
      payload: { summary: "bump deadline" },
      threadId: "t-1",
    });
    appendDecisionEvent({
      decisionId: id,
      sequenceNo: 1,
      eventKind: "proposed",
    });
    appendDecisionEvent({
      decisionId: id,
      sequenceNo: 2,
      eventKind: "executed",
    });

    const md = renderDecisionAdrById(id);
    expect(md).toBeDefined();
    expect(md).toContain(`# ADR ${id}: task_edit`);
    expect(md).toContain("- Blast radius: session");
    expect(md).toContain("seq 1: `proposed`");
    expect(md).toContain("seq 2: `executed`");
  });

  it("returns undefined for a non-existent decision id", () => {
    expect(renderDecisionAdrById(99999)).toBeUndefined();
  });
});
