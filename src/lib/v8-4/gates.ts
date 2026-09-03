/**
 * V8.4 "Honest Done" — the completion ledger.
 *
 * Doctrine (adopted from unlazy v2, 2026-08-16): "done" is a CLAIM. The
 * harness holds a ledger of acceptance gates written BEFORE the work
 * (submission / ritual / plan) or by the harness itself, runs the runnable
 * ones as subprocesses, records evidence, and only then decides what the
 * task's terminal status may say. Three properties are structural, not
 * requested:
 *
 *   1. The model cannot write the ledger. No tool exposes this table; the
 *      only writers are `declareGates` (additions only — there is no API to
 *      edit or delete a criterion) and `recordGateResult` (harness evidence).
 *      unlazy's own GATES.md is model-editable; that hole is closed here.
 *   2. Checked-without-evidence is unmet. `recordGateResult` refuses `met`
 *      without evidence, and `ledgerVerdict` counts such a row as pending.
 *   3. Surrender is visible. A gate that cannot be met is ABANDONED with a
 *      reason (parsed from the model's final report — the one thing the model
 *      may say about a gate) and every consumer lists abandoned gates.
 *
 * Mode (`TASK_GATES_MODE`): `off` (default — declare/freeze only, nothing
 * runs) · `shadow` (checks run, verdict recorded in output/trace, status
 * untouched) · `enforce` (a FAILED verdict demotes `completed` →
 * `completed_with_concerns` and the ledger block is appended to the report).
 * Unknown values resolve to `off` (dormant is the safe direction).
 */
import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { isReadbackCheck } from "./ledger-lines.js";

export type GateSource = "submission" | "ritual" | "plan" | "harness";
export type GateState = "pending" | "met" | "failed" | "abandoned";
export type GateCheckKind = "shell" | "landing" | "manual";
export type GatesMode = "off" | "shadow" | "enforce";

export interface GateSpec {
  /** Stable id (`G1`, `g-2.1`). Auto-assigned `G<n>` when absent. */
  id?: string;
  /** Observable outcome, stated so a stranger could judge it. */
  criterion: string;
  /** Shell command that proves the criterion (kind `shell`). */
  check?: string;
  /** Substring, or `/regex/flags`, the check output must contain. Absent ⇒ exit code 0 decides. */
  expect?: string;
  /** `shell` (has `check`) · `landing` (harness probes the remote) · `manual` (no runnable proof). */
  kind?: GateCheckKind;
  /**
   * Declare the row already surrendered (`state: abandoned`, this reason).
   * Used when the resolver refuses a check: the gate still appears in every
   * ledger listing instead of vanishing (doctrine 3, "surrender is visible").
   */
  abandonReason?: string;
}

export interface GateRow {
  task_id: string;
  gate_id: string;
  criterion: string;
  check_kind: GateCheckKind;
  check_cmd: string | null;
  expect: string | null;
  state: GateState;
  evidence: string | null;
  abandon_reason: string | null;
  source: GateSource;
  frozen_at: string | null;
  checked_at: string | null;
  created_at: string;
}

export const GATE_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_CRITERION = 500;
const MAX_CHECK = 2000;
const MAX_EXPECT = 500;
export const MAX_EVIDENCE = 400;

export function gatesMode(env: NodeJS.ProcessEnv = process.env): GatesMode {
  const raw = (env.TASK_GATES_MODE ?? "off").trim().toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "shadow") return "shadow";
  return "off";
}

/**
 * Validate an untrusted gates payload (ritual column JSON, API body). Throws
 * on the first malformed entry — callers decide whether to skip or fail.
 */
export function parseGateSpecs(raw: unknown): GateSpec[] {
  const value: unknown =
    typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : []) : raw;
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("gates must be a JSON array");
  return value.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`gates[${i}]: expected an object`);
    }
    const o = item as Record<string, unknown>;
    const criterion = typeof o.criterion === "string" ? o.criterion.trim() : "";
    if (!criterion || criterion.length > MAX_CRITERION) {
      throw new Error(
        `gates[${i}]: criterion must be 1..${MAX_CRITERION} chars`,
      );
    }
    const spec: GateSpec = { criterion };
    if (o.id !== undefined) {
      if (typeof o.id !== "string" || !GATE_ID_RE.test(o.id)) {
        throw new Error(`gates[${i}]: id must match ${GATE_ID_RE}`);
      }
      spec.id = o.id;
    }
    if (o.check !== undefined) {
      if (
        typeof o.check !== "string" ||
        !o.check.trim() ||
        o.check.length > MAX_CHECK
      ) {
        throw new Error(`gates[${i}]: check must be 1..${MAX_CHECK} chars`);
      }
      spec.check = o.check.trim();
      if (isLiteralSourcedCheck(spec.check)) {
        throw new Error(
          `gates[${i}]: check must observe the artifact — a literal-sourced command (echo/printf/true/false) proves nothing`,
        );
      }
    }
    if (o.expect !== undefined) {
      if (typeof o.expect !== "string" || o.expect.length > MAX_EXPECT) {
        throw new Error(`gates[${i}]: expect must be ≤${MAX_EXPECT} chars`);
      }
      spec.expect = o.expect;
    }
    if (o.kind !== undefined) {
      if (o.kind !== "shell" && o.kind !== "landing" && o.kind !== "manual") {
        throw new Error(`gates[${i}]: kind must be shell|landing|manual`);
      }
      spec.kind = o.kind;
    }
    if (
      (spec.kind ?? (spec.check ? "shell" : "manual")) === "shell" &&
      !spec.check
    ) {
      throw new Error(`gates[${i}]: kind shell requires a check command`);
    }
    return spec;
  });
}

/**
 * Gate specs a Prometheus/swarm goal carries on `metadata.gates` (planner
 * object-form criteria). Ids are `<goalId>.<n>` so a task ledger built from a
 * whole graph stays unique and traceable to its goal.
 */
/**
 * A check whose only data source is a literal proves nothing about the
 * artifact: `echo 'verify via gdocs_read' | grep -q gdocs_read && echo ok`
 * is met by construction, and `echo '<prose>'` against an EXPECT can never
 * be met. The planner emitted both shapes (2026-09-03, task e63ac8dc: gate
 * g-5.1 failed on a bare echo and the parent re-verification demoted a
 * finished 43 kB deliverable). Refused at the resolver — the first command
 * of the pipeline must be something that observes (cat/grep FILE, curl,
 * sqlite3, test -f, a test runner…). Leading VAR=value assignments are
 * skipped so `FOO=1 echo` is still caught.
 */
const LITERAL_SOURCE_RE =
  /^\s*[({]?\s*(?:(?:ba|z|da)?sh\s+-c\s+['"]?)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:command\s+|builtin\s+)?(?:\/(?:usr\/)?bin\/)?(?:echo|printf|true|false|:)(?=\s|$|[;|&)}'"])/;

/**
 * First-command anchor: also catches `(echo x)`, `{ echo x; }`, `sh -c
 * 'echo x'`, `/bin/echo`, `command echo`. Known residual: a literal AFTER a
 * real command (`cd /tmp && echo ok`, `test -z '' && echo ok`) passes — the
 * planner rule and the operator's read of the ledger cover that shape.
 */
export function isLiteralSourcedCheck(check: string): boolean {
  return LITERAL_SOURCE_RE.test(check);
}

/** Plan gate ids are `<goal>.<n>`; the goal part is sanitised like this. */
function planGateIdPrefix(goalId: string): string {
  return `${goalId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24)}.`;
}

/**
 * Surrender the still-pending plan gates of goals that never ran (orchestrator
 * early exit). Left pending they FAIL at completion and again at the parent's
 * re-verify, demoting a promoted partial for work that was never attempted.
 * Abandoned rows are skipped by evaluation and listed by every consumer.
 * Returns the number of rows changed.
 */
export function abandonPlanGatesForGoals(
  taskId: string,
  goalIds: readonly string[],
  reason: string,
  db: Database.Database = getDatabase(),
): number {
  if (goalIds.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE task_gates
        SET state = 'abandoned', abandon_reason = ?, checked_at = datetime('now')
      WHERE task_id = ? AND source = 'plan' AND state = 'pending'
        AND gate_id LIKE ? ESCAPE '\\'`,
  );
  let changed = 0;
  const tx = db.transaction(() => {
    for (const goalId of goalIds) {
      const prefix = planGateIdPrefix(goalId).replace(/[\\%_]/g, "\\$&");
      changed += stmt.run(reason.slice(0, MAX_EVIDENCE), taskId, `${prefix}%`)
        .changes;
    }
  });
  tx();
  return changed;
}

export function gateSpecsFromGoal(
  goalId: string,
  metadata: Record<string, unknown> | undefined,
): GateSpec[] {
  const raw = metadata?.gates;
  if (!Array.isArray(raw)) return [];
  const prefix = planGateIdPrefix(goalId);
  const out: GateSpec[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as { criterion?: unknown; check?: unknown; expect?: unknown };
    if (typeof o.criterion !== "string" || !o.criterion.trim()) return;
    if (typeof o.check !== "string" || !o.check.trim()) return;
    const check = o.check.trim();
    if (isLiteralSourcedCheck(check)) {
      // Refused, but visibly: the row lands ABANDONED with the reason, so
      // the ledger shows the surrender instead of a gap (doctrine 3).
      console.warn(
        `[gates] ${goalId}: plan gate ${i + 1} abandoned — check is literal-sourced, observes nothing: ${check.slice(0, 80)}`,
      );
      out.push({
        id: `${prefix}${i + 1}`,
        criterion: o.criterion.trim().slice(0, MAX_CRITERION),
        kind: "manual",
        abandonReason: `check is literal-sourced — observes nothing: ${check.slice(0, 120)}`,
      });
      return;
    }
    out.push({
      id: `${prefix}${i + 1}`,
      criterion: o.criterion.trim().slice(0, MAX_CRITERION),
      check: check.slice(0, MAX_CHECK),
      ...(typeof o.expect === "string" && o.expect && {
        expect: o.expect.slice(0, MAX_EXPECT),
      }),
      kind: "shell",
    });
  });
  return out;
}

function resolveKind(spec: GateSpec): GateCheckKind {
  return spec.kind ?? (spec.check ? "shell" : "manual");
}

/**
 * Add gates to a task's ledger. Additions only: an existing (task, gate_id)
 * row is never overwritten (INSERT OR IGNORE), so a later declaration can
 * add gates but can never rewrite or drop an earlier one. Returns the number
 * of rows actually inserted.
 */
export function declareGates(
  taskId: string,
  specs: readonly GateSpec[],
  source: GateSource,
  db: Database.Database = getDatabase(),
): number {
  if (specs.length === 0) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO task_gates
       (task_id, gate_id, criterion, check_kind, check_cmd, expect, source, state, abandon_reason)
     VALUES (@taskId, @gateId, @criterion, @kind, @check, @expect, @source, @state, @abandonReason)`,
  );
  const existingIds = db
    .prepare(`SELECT gate_id FROM task_gates WHERE task_id = ?`)
    .all(taskId)
    .map((r) => (r as { gate_id: string }).gate_id);
  const taken = new Set(existingIds);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const spec of specs) {
      let gateId = spec.id;
      if (!gateId) {
        let n = taken.size + 1;
        while (taken.has(`G${n}`)) n++;
        gateId = `G${n}`;
      }
      if (!GATE_ID_RE.test(gateId)) {
        throw new Error(`gate id ${JSON.stringify(gateId)} is not valid`);
      }
      // `RB-…` ids are the harness's read-back namespace (readback.ts): a
      // submission/plan gate could otherwise pre-empt a write proof by
      // claiming its deterministic id (R2 audit W5).
      if (gateId.startsWith("RB-") && source !== "harness") {
        throw new Error(`gate id ${JSON.stringify(gateId)} is reserved for harness read-backs`);
      }
      const kind = resolveKind(spec);
      const info = insert.run({
        taskId,
        gateId,
        criterion: spec.criterion.slice(0, MAX_CRITERION),
        kind,
        // A `manual` row may carry a `readback:` payload (src/lib/v8-4/readback.ts)
        // — the harness runs its verifier at completion; any other manual
        // check text is dropped (no runnable proof).
        check:
          kind === "shell" ||
          (kind === "manual" &&
            source === "harness" &&
            spec.check?.startsWith("readback:"))
            ? (spec.check ?? null)
            : null,
        expect: kind === "shell" ? (spec.expect ?? null) : null,
        source,
        state: spec.abandonReason ? "abandoned" : "pending",
        abandonReason: spec.abandonReason?.slice(0, MAX_EVIDENCE) ?? null,
      });
      if (info.changes > 0) {
        inserted++;
        taken.add(gateId);
      }
    }
  });
  tx();
  return inserted;
}

/** Stamp the reference: gates declared so far are the fixed contract for this run. */
export function freezeGates(
  taskId: string,
  db: Database.Database = getDatabase(),
): void {
  db.prepare(
    `UPDATE task_gates SET frozen_at = datetime('now') WHERE task_id = ? AND frozen_at IS NULL`,
  ).run(taskId);
}

export function listGates(
  taskId: string,
  db: Database.Database = getDatabase(),
): GateRow[] {
  return db
    .prepare(`SELECT * FROM task_gates WHERE task_id = ? ORDER BY rowid`)
    .all(taskId) as GateRow[];
}

export function hasGates(
  taskId: string,
  db: Database.Database = getDatabase(),
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM task_gates WHERE task_id = ? LIMIT 1`)
      .get(taskId) !== undefined
  );
}

export type GateResult =
  | { state: "met"; evidence: string }
  | { state: "failed"; evidence: string }
  | { state: "abandoned"; reason: string };

/**
 * Harness-only evidence writer. `met` REQUIRES evidence (throws otherwise —
 * a checkbox is a claim, evidence is the proof). An abandoned gate is final:
 * it is never flipped back by a later check. Returns whether a row changed.
 */
export function recordGateResult(
  taskId: string,
  gateId: string,
  result: GateResult,
  db: Database.Database = getDatabase(),
): boolean {
  if (result.state === "abandoned") {
    const reason = result.reason.trim().slice(0, 300);
    if (!reason) throw new Error(`gate ${gateId}: abandon requires a reason`);
    const info = db
      .prepare(
        `UPDATE task_gates SET state = 'abandoned', abandon_reason = ?, checked_at = datetime('now')
         WHERE task_id = ? AND gate_id = ? AND state IN ('pending','failed')`,
      )
      .run(reason, taskId, gateId);
    return info.changes > 0;
  }
  const evidence = result.evidence.trim().slice(0, MAX_EVIDENCE);
  if (result.state === "met" && !evidence) {
    throw new Error(`gate ${gateId}: met requires evidence`);
  }
  const info = db
    .prepare(
      `UPDATE task_gates SET state = ?, evidence = ?, checked_at = datetime('now')
       WHERE task_id = ? AND gate_id = ? AND state != 'abandoned'`,
    )
    .run(result.state, evidence || null, taskId, gateId);
  return info.changes > 0;
}

const ABANDON_RE =
  /^[ \t]*ABANDON:[ \t]*([A-Za-z0-9._-]+):?[ \t]*(?:[—–-][ \t]*)?(.*)$/gm;

/** `ABANDON: <gate id> <reason>` lines in a report — the honest exit. */
export function parseAbandonLines(
  text: string,
): Array<{ gateId: string; reason: string }> {
  const out: Array<{ gateId: string; reason: string }> = [];
  for (const m of text.matchAll(ABANDON_RE)) {
    const gateId = m[1].replace(/:$/, "");
    if (!GATE_ID_RE.test(gateId)) continue;
    out.push({ gateId, reason: (m[2] ?? "").trim() || "(no reason given)" });
  }
  return out;
}

export type LedgerVerdictKind = "none" | "met" | "failed" | "unverified";

export interface LedgerVerdict {
  verdict: LedgerVerdictKind;
  total: number;
  met: number;
  failed: number;
  pending: number;
  abandoned: number;
  failedRows: GateRow[];
  pendingRows: GateRow[];
  abandonedRows: GateRow[];
}

/**
 * Pure adjudication. `met` needs every non-abandoned gate met WITH evidence;
 * any failed check ⇒ `failed`; otherwise something is still unproven ⇒
 * `unverified` (never silently `met`).
 */
export function ledgerVerdict(rows: readonly GateRow[]): LedgerVerdict {
  const failedRows: GateRow[] = [];
  const pendingRows: GateRow[] = [];
  const abandonedRows: GateRow[] = [];
  let met = 0;
  for (const r of rows) {
    if (r.state === "abandoned") abandonedRows.push(r);
    else if (r.state === "failed") failedRows.push(r);
    else if (r.state === "met" && r.evidence && r.evidence.trim()) met++;
    else pendingRows.push(r);
  }
  const total = rows.length;
  const verdict: LedgerVerdictKind =
    total === 0
      ? "none"
      : failedRows.length > 0
        ? "failed"
        : pendingRows.length > 0
          ? "unverified"
          : "met";
  return {
    verdict,
    total,
    met,
    failed: failedRows.length,
    pending: pendingRows.length,
    abandoned: abandonedRows.length,
    failedRows,
    pendingRows,
    abandonedRows,
  };
}

/** Prompt block appended to a task's description when it has a ledger. */
export function renderGatesBlock(rows: readonly GateRow[]): string {
  // Read-back rows are harness proofs the model cannot influence — never
  // shown to the runner as "state the evidence in your report".
  rows = rows.filter((r) => !isReadbackRowLike(r));
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const proof =
      r.check_kind === "shell" && r.check_cmd
        ? ` [CHECK: ${r.check_cmd}${r.expect ? ` → EXPECT: ${r.expect}` : ""}]`
        : r.check_kind === "landing"
          ? " [harness verifies the branch/PR/commit you report exists on origin]"
          : " [manual — state the evidence in your report]";
    return `- ${r.gate_id}: ${r.criterion}${proof}`;
  });
  return (
    `\n\n## Acceptance gates (harness ledger)\n` +
    `The harness will check these after you finish; you cannot mark them yourself.\n` +
    lines.join("\n") +
    `\nIf a gate is genuinely impossible, write a line \`ABANDON: <gate id> <reason>\` in your final report instead of silently narrowing the scope.`
  );
}

/** Compact JSON summary stored on `tasks.output.gates`. */
const isReadbackRowLike = (r: Pick<GateRow, "check_kind" | "check_cmd">) =>
  isReadbackCheck(r.check_kind, r.check_cmd);

export function ledgerSummaryJson(
  rows: readonly GateRow[],
  mode: GatesMode,
): Record<string, unknown> {
  // One population for the JSON summary and the rendered block: read-back
  // rows are reported separately (`readback` key) — R2 audit C1.
  const readbackRows = rows.filter(isReadbackRowLike);
  rows = rows.filter((r) => !isReadbackRowLike(r));
  const v = ledgerVerdict(rows);
  return {
    mode,
    verdict: v.verdict,
    total: v.total,
    met: v.met,
    failed: v.failed,
    pending: v.pending,
    abandoned: v.abandoned,
    gates: rows.map((r) => ({
      id: r.gate_id,
      state: r.state,
      kind: r.check_kind,
      source: r.source,
      ...(r.evidence && { evidence: r.evidence }),
      ...(r.abandon_reason && { reason: r.abandon_reason }),
    })),
    ...(readbackRows.length > 0 && {
      readback: {
        total: readbackRows.length,
        met: readbackRows.filter((r) => r.state === "met").length,
        failed: readbackRows.filter((r) => r.state === "failed").length,
        pending: readbackRows.filter((r) => r.state === "pending").length,
        withdrawn: readbackRows.filter((r) => r.state === "abandoned").length,
        gates: readbackRows.map((r) => ({
          id: r.gate_id,
          state: r.state,
          ...(r.evidence && { evidence: r.evidence }),
        })),
      },
    }),
  };
}

/** Human-readable ledger block appended to a delivered report (enforce mode). */
export function formatLedgerBlock(rows: readonly GateRow[]): string {
  // Read-back rows (harness `readback:` payloads) render through their own
  // Spanish lines (src/lib/v8-4/readback.ts) — never as this English block.
  rows = rows.filter((r) => !isReadbackRowLike(r));
  const v = ledgerVerdict(rows);
  if (v.total === 0) return "";
  const parts = [`Gates: ${v.met}/${v.total} met`];
  if (v.failedRows.length) {
    parts.push(
      `FAILED: ${v.failedRows.map((r) => `${r.gate_id} (${r.evidence ?? "no evidence"})`).join("; ")}`,
    );
  }
  if (v.pendingRows.length) {
    parts.push(`unverified: ${v.pendingRows.map((r) => r.gate_id).join(", ")}`);
  }
  if (v.abandonedRows.length) {
    parts.push(
      `ABANDONED: ${v.abandonedRows.map((r) => `${r.gate_id} (${r.abandon_reason})`).join("; ")}`,
    );
  }
  return parts.join(" · ");
}
