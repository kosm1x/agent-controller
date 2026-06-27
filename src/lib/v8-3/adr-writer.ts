/**
 * V8.3 Phase 4 — ADR lazy-render (spec §9).
 *
 * Renders a `decisions` row as a MADR-adapted Markdown Architecture Decision
 * Record, ON DEMAND. The DB row + `decision_events` are the source of truth —
 * nothing is eager-written per decision (R2 #13). A later caller (the Phase-6
 * `jarvis_audit_decisions` tool, or an operator veto/export handler) materializes
 * the string to `logs/decisions/<id>-<capability>-<slug>.md`; THIS phase ships the
 * pure renderer + filename builder only. No `index.ts` call site — substrate,
 * dormant by construction like `reversal.ts` / `pipeline.ts`.
 *
 * `renderDecisionAdr` is pure (row + events + optional capability in → markdown
 * out, JSON columns parsed defensively); `renderDecisionAdrById` is the thin
 * fetch-then-render convenience over the `decisions-store` readers.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import {
  getCapabilityRow,
  getDecisionById,
  getDecisionEvents,
} from "./decisions-store.js";
import type {
  CapabilityAutonomyRow,
  DecisionEventRow,
  DecisionRow,
  DecisionStatus,
} from "./types.js";
import type { ReversalOp } from "./reversal.js";

export interface AdrRenderInput {
  decision: DecisionRow;
  /** Append-only event history (ordered by sequence_no), for the Consequences timeline. */
  events: DecisionEventRow[];
  /** The capability's autonomy row, for blast_radius. Optional — an unseeded
   *  capability renders without that line rather than throwing. */
  capability?: CapabilityAutonomyRow;
}

// ── status lifecycle (§9: Proposed → Committed → Reverted → Superseded-by-N → Vetoed) ──

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: "Proposed",
  committed: "Committed",
  reverted: "Reverted",
  vetoed: "Vetoed",
  interrupted: "Interrupted",
};

/**
 * §9 human status label. `superseded_by` is a derived state (the DB `status`
 * CHECK has no 'superseded' value — supersession is a pointer), so a row with a
 * `superseded_by` pointer reads "Superseded by N" regardless of its raw status.
 */
export function statusLabel(
  d: Pick<DecisionRow, "status" | "superseded_by">,
): string {
  if (d.superseded_by != null) return `Superseded by ${d.superseded_by}`;
  return STATUS_LABEL[d.status] ?? d.status;
}

// ── reversal procedure (one line per §7 ReversalOp kind) ──────────────────────

/** Human-readable reversal procedure from the stored `reversal_op_json`. */
export function renderReversalProcedure(op: ReversalOp | null): string {
  if (!op) return "None recorded.";
  switch (op.kind) {
    case "sql_inverse":
      return `Automatic — SQL inverse rollback in one transaction (${op.steps.length} step(s) over ${op.tables.join(", ") || "—"}); restoration verified by content fingerprint.`;
    case "compensating":
      return `Operator-confirmed — no clean inverse; reversal is PROPOSED, never auto-executed: ${op.proposal}`;
    case "irreversible":
      return `Irreversible — ${op.reason}`;
    case "deferred":
      return `Deferred (${op.strategy}) — ${op.note}`;
    default:
      return "Unknown reversal procedure.";
  }
}

// ── defensive JSON + slug helpers ─────────────────────────────────────────────

/** The only legal `ReversalOp.kind` values (§7). Validating against this — not
 *  just `typeof kind === "string"` — keeps an unknown/crafted kind out of the
 *  `reversal_procedure:` frontmatter line (it is emitted raw), closing a
 *  theoretical injection on this future audit-export surface. */
const REVERSAL_KINDS = new Set<ReversalOp["kind"]>([
  "sql_inverse",
  "compensating",
  "irreversible",
  "deferred",
]);

function parseReversalOp(json: string | null): ReversalOp | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    const kind = (v as { kind?: unknown } | null)?.kind;
    if (
      typeof kind === "string" &&
      REVERSAL_KINDS.has(kind as ReversalOp["kind"])
    ) {
      return v as ReversalOp;
    }
  } catch {
    /* malformed blob → no recorded procedure */
  }
  return null;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json; // not JSON — show as-is
  }
}

/** Filename-safe slug: lowercase, non-alnum → '-', collapsed, capped. */
function slug(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (out || "decision").slice(0, max).replace(/-+$/, "") || "decision";
}

/** A short human descriptor pulled from the payload for the ADR filename slug. */
function payloadDescriptor(payload: Record<string, unknown>): string {
  for (const k of [
    "summary",
    "title",
    "description",
    "action",
    "reason",
    "name",
  ]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * Relative path a materialized ADR would take (§9):
 * `logs/decisions/<id>-<capability>-<slug>.md`. The slug favors a payload
 * descriptor, else a stable "decision". Returns the path only — the WRITE
 * (jarvis_files vs FS) is the caller's decision in a later phase.
 */
export function adrFilename(
  d: Pick<DecisionRow, "id" | "capability" | "payload_json">,
): string {
  const desc = payloadDescriptor(parsePayload(d.payload_json));
  const tail = desc ? slug(desc) : "decision";
  return `logs/decisions/${d.id}-${slug(d.capability)}-${tail}.md`;
}

// ── frontmatter ───────────────────────────────────────────────────────────────

function fmLine(key: string, value: string | number | null): string {
  return `${key}: ${value === null ? "null" : value}`;
}

function renderFrontmatter(d: DecisionRow, op: ReversalOp | null): string {
  const lines = [
    fmLine("id", d.id),
    fmLine("date", d.proposed_at.slice(0, 10)),
    fmLine("capability", d.capability),
    fmLine("autonomy_level", d.autonomy_level),
    fmLine("status", statusLabel(d)),
    fmLine("supersedes", d.supersedes),
    fmLine("superseded_by", d.superseded_by),
    fmLine("operator_override", d.operator_override_kind ?? "none"),
    fmLine("reversal_procedure", op?.kind ?? "none"),
    fmLine("judgment_id", d.judgment_id),
    fmLine("pheropath_signal", d.pheropath_signal),
  ];
  return `---\n${lines.join("\n")}\n---`;
}

// ── the renderer ──────────────────────────────────────────────────────────────

/**
 * Render a decision as a MADR-adapted Markdown ADR (§9): frontmatter + the six
 * sections Context / Decision / Confidence and basis / Consequences / Reversal
 * procedure / Cross-references. Pure — all derivation is from the passed row,
 * events, and optional capability; no DB or FS access.
 */
export function renderDecisionAdr(input: AdrRenderInput): string {
  const { decision: d, events, capability } = input;
  const op = parseReversalOp(d.reversal_op_json);
  const label = statusLabel(d);

  const judgmentLine =
    d.judgment_id != null
      ? `- Linked V8.2 judgment: #${d.judgment_id}`
      : "- No linked V8.2 judgment (sub-L3 / did not pass the consent layer)";
  const pheroLine = d.pheropath_signal
    ? `\n- PheroPath signal: ${d.pheropath_signal}`
    : "";
  const decidedLine = d.decided_at ? `, decided ${d.decided_at}` : "";

  const eventTimeline =
    events.length > 0
      ? events
          .map(
            (e) =>
              `- seq ${e.sequence_no}: \`${e.event_kind}\` @ ${e.occurred_at}`,
          )
          .join("\n")
      : "- (no events recorded)";

  const basis =
    d.judgment_id != null
      ? `Grounded in V8.2 judgment #${d.judgment_id} — its confidence color and critic verdict are the basis for autonomous eligibility.`
      : "No linked V8.2 judgment — this decision did not pass through the consent layer (expected for an L≤2 confirm record).";
  const basisPhero = d.pheropath_signal
    ? ` PheroPath closed-loop signal: ${d.pheropath_signal}.`
    : "";

  return `${renderFrontmatter(d, op)}

# ADR ${d.id}: ${d.capability} — ${label}

## Context
- Autonomy level: L${d.autonomy_level}
- Proposed: ${d.proposed_at}${decidedLine}
- Thread: ${d.thread_id}
${judgmentLine}${pheroLine}

## Decision
Capability \`${d.capability}\` with payload:

\`\`\`json
${prettyJson(d.payload_json)}
\`\`\`

## Confidence and basis
${basis}${basisPhero}

## Consequences
- Blast radius: ${capability ? capability.blast_radius : "unknown (capability not seeded)"}
- Status: ${label}
- Event history:
${eventTimeline}

## Reversal procedure
${renderReversalProcedure(op)}

## Cross-references
- Decision id: ${d.id}
- V8.2 judgment: ${d.judgment_id != null ? `#${d.judgment_id}` : "none"}
- Thread: ${d.thread_id}
- Supersedes: ${d.supersedes != null ? `decision ${d.supersedes}` : "none"}
- Superseded by: ${d.superseded_by != null ? `decision ${d.superseded_by}` : "none"}
- Operator override: ${d.operator_override_kind ?? "none"}
`;
}

/**
 * Fetch a decision (+ its events + capability row) and render its ADR. Returns
 * undefined if no decision with that id exists. Uses the `getDatabase()`
 * singleton unless a db is injected (tests).
 */
export function renderDecisionAdrById(
  id: number,
  db: Database.Database = getDatabase(),
): string | undefined {
  const decision = getDecisionById(id, db);
  if (!decision) return undefined;
  const events = getDecisionEvents(id, db);
  const capability = getCapabilityRow(decision.capability, db);
  return renderDecisionAdr({ decision, events, capability });
}
