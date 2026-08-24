/**
 * Read-back gates — Phase 2 of docs/planning/jarvis-usability-plan-2026-08-22.md
 * ("Honest Done for writes").
 *
 * "Listo" is a claim. The 2026-08-22 review counted ≥15 false-done claims:
 * a mailbox announced with a password that did not exist (#11181), a Sheet
 * contradicting the model the operator had just confirmed (#11959), three
 * "KB actualizado" that never persisted (#11750/#11820). Every one of them
 * was a WRITE the model described instead of re-reading.
 *
 * A write tool that succeeds declares a harness gate on the current task:
 * "what I wrote can be read back". At completion `evaluateLedger` runs the
 * registered verifier for that tool — it re-reads the artifact through the
 * same API and compares it with what the write claimed — and records
 * met/failed WITH EVIDENCE. A failed read-back demotes the task to
 * completed_with_concerns and the deliverable says `No quedó: …`. This is
 * the plan's write-class enforce: it applies under `shadow` and `enforce`
 * alike (never under `off`, where no ledger runs), because the proof is
 * deterministic and harness-owned.
 *
 * Identity (R1 audit C1): gates are keyed by ARTIFACT — `RB-<sha8(tool
 * class + artifact key)>` — and the latest write to the same artifact in
 * one task SUPERSEDES the earlier gate (re-points the payload, resets the
 * state). "Write a doc, then append a section" (8 % of KB-writing tasks)
 * must prove the final state once, not contradict itself. A same-task
 * delete WITHDRAWS the gate (harness-abandoned, rendered silently).
 *
 * Ledger doctrine: the model still has no writer — `supersede`/`withdraw`
 * are harness-only and touch only `source='harness'` read-back rows; the
 * model's ABANDON lines cannot target read-back gates (gate-check excludes
 * them); met still requires evidence.
 *
 * Timing: the V8.4 spec declares gates BEFORE the work; a read-back gate is
 * declared DURING the run, by the harness, at the moment a write succeeds.
 * `evaluateLedger` freezes and lists rows at completion, so mid-run rows are
 * evaluated.
 *
 * Storage: `check_kind` carries a CHECK constraint ('shell','landing',
 * 'manual') that only a table rebuild could widen, so a read-back gate is a
 * `manual` row whose `check_cmd` is `readback:<json>`; `declareGates` keeps
 * that text only for `source='harness'` (R1 audit W1).
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getDatabase } from "../../db/index.js";
import { declareGates, type GateRow } from "./gates.js";
import { READBACK_PREFIX, isReadbackCheck } from "./ledger-lines.js";
import { getTaskConfirmedFigures } from "../../messaging/thread-pins.js";

export { READBACK_PREFIX };
const MAX_PAYLOAD = 2000; // mirrors gates.ts MAX_CHECK
const MAX_LINES = 3;
/** Effective per-verifier timeout; gate-check passes min(this, its own). */
export const READBACK_TIMEOUT_MS = 15_000;

export interface ReadbackPayload {
  tool: string;
  /** Tool-specific data needed to re-read and compare. */
  data: Record<string, unknown>;
}

export interface ReadbackVerdict {
  ok: boolean;
  /** ≤ 400 chars, what was actually read back. Spanish, phone-ready. */
  evidence: string;
}

export type ReadbackVerifier = (
  data: Record<string, unknown>,
) => Promise<ReadbackVerdict>;

const verifiers = new Map<string, ReadbackVerifier>();

export function registerReadback(tool: string, fn: ReadbackVerifier): void {
  verifiers.set(tool, fn);
}

export function hasReadback(tool: string): boolean {
  return verifiers.has(tool);
}

/** Test seam. */
export function _resetReadbacks(): void {
  verifiers.clear();
}

export function sha8(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Artifact-keyed gate id. Same artifact in the same task ⇒ same id. */
export function readbackGateId(artifactKey: string): string {
  return `RB-${sha8(artifactKey)}`;
}

export function isReadbackRow(row: Pick<GateRow, "check_kind" | "check_cmd">) {
  return isReadbackCheck(row.check_kind, row.check_cmd);
}

/** A read-back the harness itself withdrew (same-task delete) — rendered silently. */
export function isWithdrawnReadback(row: GateRow): boolean {
  return (
    isReadbackRow(row) &&
    row.state === "abandoned" &&
    (row.abandon_reason ?? "").startsWith("harness:")
  );
}

export function parseReadback(
  row: Pick<GateRow, "check_cmd">,
): ReadbackPayload | null {
  if (!row.check_cmd || !row.check_cmd.startsWith(READBACK_PREFIX)) return null;
  try {
    const parsed = JSON.parse(row.check_cmd.slice(READBACK_PREFIX.length));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string" &&
      parsed.data &&
      typeof parsed.data === "object"
    ) {
      return parsed as ReadbackPayload;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Declare — or supersede — the read-back gate for `artifactKey` on `taskId`
 * after a write the API reported as successful. Called by tool handlers
 * (task id from the run context); a no-op when the tool has no verifier or
 * no task is running. Never throws — a ledger hiccup must not fail the
 * write it records. Returns true when a row was inserted or re-pointed.
 */
export function declareReadbackGate(
  taskId: string | null | undefined,
  tool: string,
  artifactKey: string,
  criterion: string,
  data: Record<string, unknown>,
  db: Database.Database = getDatabase(),
): boolean {
  if (!taskId || !verifiers.has(tool)) return false;
  try {
    // Identity is the ARTIFACT (e.g. `kb:<path>`), not the tool: a
    // jarvis_file_write followed by a jarvis_file_update on the same path is
    // ONE proof — the final state.
    const gateId = readbackGateId(artifactKey);
    // Phase 2.3: figures the operator confirmed in the originating thread
    // ride the payload, so the verifier can fail a write that contradicts
    // the confirmed model — not just one that differs from what the model
    // claims it wrote (#11959). Bounded (≤5 figures, labels ≤80 chars) so
    // the payload stays inside MAX_PAYLOAD.
    const confirmed = getTaskConfirmedFigures(taskId)
      .slice(0, 5)
      .map((f) => ({ raw: f.raw, label: f.label.slice(0, 80) }));
    const payload: ReadbackPayload = {
      tool,
      data: confirmed.length > 0 ? { ...data, __confirmed: confirmed } : data,
    };
    let check = READBACK_PREFIX + JSON.stringify(payload);
    if (check.length > MAX_PAYLOAD && confirmed.length > 0) {
      // Shed the 2.3 extra first — losing the contradiction check is
      // strictly better than losing the whole read-back (R1 audit rec).
      check = READBACK_PREFIX + JSON.stringify({ tool, data });
    }
    if (check.length > MAX_PAYLOAD) {
      // Oversized payloads (a huge first row) are not worth a ledger row that
      // cannot be stored faithfully — keep the identity, drop the detail.
      check =
        READBACK_PREFIX + JSON.stringify({ tool, data: { truncated: true } });
    }
    const crit = criterion.slice(0, 500);
    const existing = db
      .prepare(
        `SELECT source, check_cmd FROM task_gates WHERE task_id = ? AND gate_id = ?`,
      )
      .get(taskId, gateId) as
      { source: string; check_cmd: string | null } | undefined;
    if (existing) {
      if (
        existing.source !== "harness" ||
        !isReadbackRow({ check_kind: "manual", check_cmd: existing.check_cmd })
      ) {
        return false; // never touch a row the harness did not author
      }
      // Supersede: the latest write to this artifact is the one to prove.
      db.prepare(
        `UPDATE task_gates
            SET criterion = ?, check_cmd = ?, state = 'pending', evidence = NULL,
                abandon_reason = NULL, checked_at = NULL
          WHERE task_id = ? AND gate_id = ? AND source = 'harness'`,
      ).run(crit, check, taskId, gateId);
      return true;
    }
    return (
      declareGates(
        taskId,
        [{ id: gateId, criterion: crit, kind: "manual", check }],
        "harness",
        db,
      ) > 0
    );
  } catch (err) {
    console.warn(`[readback] could not declare gate for ${tool}:`, err);
    return false;
  }
}

/**
 * Withdraw the read-back for an artifact the SAME task then deleted: the
 * earlier proof is moot, not failed. Harness-abandoned rows render nothing.
 */
export function withdrawReadbackGate(
  taskId: string | null | undefined,
  tool: string,
  artifactKey: string,
  reason: string,
  db: Database.Database = getDatabase(),
): boolean {
  if (!taskId) return false;
  try {
    const gateId = readbackGateId(artifactKey);
    const info = db
      .prepare(
        `UPDATE task_gates
            SET state = 'abandoned', abandon_reason = ?, checked_at = datetime('now')
          WHERE task_id = ? AND gate_id = ? AND source = 'harness'
            AND check_cmd LIKE '${READBACK_PREFIX}%'`,
      )
      .run(`harness: ${reason}`.slice(0, 300), taskId, gateId);
    return info.changes > 0;
  } catch (err) {
    console.warn(`[readback] could not withdraw gate for ${tool}:`, err);
    return false;
  }
}

/** Phone-ready wording for a verifier that could not even re-read. */
function describeThrow(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /\b(\d{3})\b/.exec(msg)?.[1];
  const kind = /403|permission|forbidden/i.test(msg)
    ? "permiso denegado"
    : /404|not ?found/i.test(msg)
      ? "no encontrado"
      : /401|auth/i.test(msg)
        ? "sesión vencida"
        : /timeout|timed out|abort/i.test(msg)
          ? "sin respuesta"
          : "error";
  console.warn(`[readback] verifier threw: ${msg.slice(0, 300)}`);
  return `no pude releerlo (${kind}${http ? ` HTTP ${http}` : ""})`;
}

/** Run the verifier for one read-back row. Unknown tool ⇒ failed with reason. */
export async function runReadback(
  row: Pick<GateRow, "check_cmd">,
  timeoutMs = READBACK_TIMEOUT_MS,
): Promise<ReadbackVerdict> {
  const payload = parseReadback(row);
  if (!payload)
    return { ok: false, evidence: "no pude releerlo (registro ilegible)" };
  const fn = verifiers.get(payload.tool);
  if (!fn)
    return {
      ok: false,
      evidence: `no pude releerlo (sin verificador para ${payload.tool})`,
    };
  const effective = Math.min(timeoutMs, READBACK_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      fn(payload.data),
      new Promise<ReadbackVerdict>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              evidence: `no pude releerlo (sin respuesta en ${Math.round(effective / 1000)} s)`,
            }),
          effective,
        );
      }),
    ]);
    return { ok: verdict.ok, evidence: verdict.evidence.slice(0, 400) };
  } catch (err) {
    return { ok: false, evidence: describeThrow(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function capLines(items: string[], render: (s: string[]) => string): string {
  const shown = items.slice(0, MAX_LINES);
  const rest = items.length - shown.length;
  return render(shown) + (rest > 0 ? ` · y ${rest} más` : "");
}

/** Lines for failed read-backs — appended to the deliverable. */
export function formatNoQuedo(rows: readonly GateRow[]): string {
  const failed = rows.filter((r) => isReadbackRow(r) && r.state === "failed");
  if (failed.length === 0) return "";
  return capLines(
    failed.map(
      (r) =>
        `⚠️ No quedó: ${r.criterion}${r.evidence ? ` — ${r.evidence}` : ""}`,
    ),
    (s) => s.join("\n"),
  );
}

/** One line for met read-backs — the honest "verificado". */
export function formatVerificado(rows: readonly GateRow[]): string {
  const met = rows.filter((r) => isReadbackRow(r) && r.state === "met");
  if (met.length === 0) return "";
  return capLines(
    met.map((r) => r.evidence ?? r.criterion),
    (s) => `✔ Verificado: ${s.join(" · ")}`,
  );
}

/** Read-backs the ledger could not run (budget exhausted) — never silent (R2 audit W6). */
export function formatSinReleer(rows: readonly GateRow[]): string {
  const pending = rows.filter((r) => isReadbackRow(r) && r.state === "pending");
  if (pending.length === 0) return "";
  return capLines(
    pending.map((r) => r.criterion),
    (s) => `⏳ Sin releer (no alcancé a verificar): ${s.join(" · ")}`,
  );
}
