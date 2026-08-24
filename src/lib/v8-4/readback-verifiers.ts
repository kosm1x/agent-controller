/**
 * Read-back verifiers — one per write class (usability plan Phase 2.1).
 *
 * Each verifier re-reads the artifact through the SAME API the write used
 * and compares it with what the write claimed. It returns evidence a
 * stranger could check, never the model's description of the write.
 *
 * Registered once at boot (`registerReadbackVerifiers()` from index.ts);
 * the tool handlers only call `declareReadbackGate(...)` after a write that
 * the API reported as successful.
 */

import { getFile } from "../../db/jarvis-fs.js";
import { getSchedule } from "../../rituals/dynamic.js";
import { googleFetch } from "../../google/client.js";
import { registerReadback, sha8, type ReadbackVerdict } from "./readback.js";
import {
  confirmedMismatch,
  type ConfirmedFigure,
} from "../../messaging/thread-pins.js";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Phase 2.3: fail the read-back when the artifact CONTRADICTS a figure the
 *  operator confirmed in the originating thread (#11959 — the Sheet said
 *  the opposite of the model confirmed minutes earlier). `__confirmed` is
 *  embedded by declareReadbackGate; absent for tasks with no confirmation.
 *  Returns null when there is no contradiction. */
function confirmedCheck(
  data: Record<string, unknown>,
  readText: string,
): ReadbackVerdict | null {
  const confirmed = Array.isArray(data.__confirmed)
    ? (data.__confirmed as ConfirmedFigure[])
    : [];
  if (confirmed.length === 0) return null;
  const hit = confirmedMismatch(readText, confirmed);
  if (!hit) return null;
  return {
    ok: false,
    evidence: `Contradice la cifra confirmada «${hit.figure.raw}» (${hit.figure.label.slice(0, 60)}): la línea dice «${hit.line}»`,
  };
}

/**
 * Sheets writes use USER_ENTERED, so "40%" is stored as 0.4 and "1,000" as
 * 1000; the default read (FORMATTED_VALUE) usually renders them back, but
 * not always identically. Compare loosely: whitespace/case-insensitive, and
 * numerically when both sides parse as numbers (after stripping $ , %).
 */
export function cellEquals(got: string, want: string): boolean {
  // A formula is evaluated by Sheets — the written source never reads back.
  if (want.startsWith("=")) return true;
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  if (norm(got) === norm(want)) return true;
  // Dates: "2026-08-22" written into a date-formatted cell renders as
  // "22/08/2026" (or "8/22/2026" under a US locale) — compare calendar days.
  const day = (s: string): string | null => {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
    if (m) {
      // Accept either day-first or month-first — both are valid renderings
      // of the same ISO date; an ambiguous pair like 3/4 vs 4/3 is rare.
      const a = m[1].padStart(2, "0");
      const b = m[2].padStart(2, "0");
      return `${m[3]}-${b}-${a}|${m[3]}-${a}-${b}`;
    }
    return null;
  };
  const dg = day(got);
  const dw = day(want);
  if (dg && dw) {
    const gs = dg.split("|");
    const ws = dw.split("|");
    if (gs.some((g) => ws.includes(g))) return true;
  }
  // Accounting negatives: "(1,234)" ≡ "-1234".
  const acct = (s: string) => s.replace(/^\((.*)\)$/, "-$1");
  got = acct(got);
  want = acct(want);
  const num = (s: string): number | null => {
    const cleaned = s.replace(/[$,\s]/g, "");
    if (!/^-?\d+(?:\.\d+)?%?$/.test(cleaned)) return null;
    const pct = cleaned.endsWith("%");
    const n = Number(pct ? cleaned.slice(0, -1) : cleaned);
    return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
  };
  const a = num(got);
  const b = num(want);
  return a !== null && b !== null && Math.abs(a - b) < 1e-9;
}

/**
 * Knowledge base. A full write proves the content hash; an update proves
 * the appended text is present (`must_contain`) and the row is at least as
 * fresh as the claim (`declared_at`, UTC "YYYY-MM-DD HH:MM:SS" — the same
 * shape as `updated_at`). A metadata-only update proves existence+freshness.
 */
export async function verifyKbFile(
  data: Record<string, unknown>,
): Promise<ReadbackVerdict> {
  const path = asString(data.path);
  const expected = asString(data.sha8);
  const mustContain = asString(data.must_contain);
  const declaredAt = asString(data.declared_at);
  const file = getFile(path);
  if (!file)
    return { ok: false, evidence: `KB ${path}: no existe tras la escritura` };
  const actual = sha8(file.content);
  if (expected && actual !== expected) {
    return {
      ok: false,
      evidence: `KB ${path}: contenido distinto al escrito (sha ${actual} ≠ ${expected})`,
    };
  }
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  if (mustContain && !norm(file.content).includes(norm(mustContain))) {
    return {
      ok: false,
      evidence: `KB ${path}: el texto agregado no aparece («${norm(mustContain).slice(0, 40)}…»)`,
    };
  }
  if (declaredAt && file.updated_at < declaredAt) {
    return {
      ok: false,
      evidence: `KB ${path}: sin cambios desde ${file.updated_at} (la escritura fue ${declaredAt})`,
    };
  }
  if (!file.content.trim()) {
    return { ok: false, evidence: `KB ${path}: quedó vacío` };
  }
  return {
    ok: true,
    evidence: `KB ${path} (sha ${actual}, ${file.content.length} chars, ${file.updated_at})`,
  };
}

/** Google Sheets: the updated range reads back with the first row we sent. */
export async function verifySheetWrite(
  data: Record<string, unknown>,
): Promise<ReadbackVerdict> {
  const id = asString(data.spreadsheet_id);
  const range = asString(data.range);
  const first = Array.isArray(data.first_row)
    ? (data.first_row as unknown[])
    : [];
  const res = await googleFetch<{ values?: unknown[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
  );
  const got = res.values ?? [];
  if (got.length === 0) {
    return { ok: false, evidence: `Sheet ${range}: vacío al releer` };
  }
  const gotFirst = (got[0] ?? []).map((c) => String(c ?? "").trim());
  const want = first.map((c) => String(c ?? "").trim());
  const mismatch = want.findIndex(
    (w, i) => w !== "" && !cellEquals(gotFirst[i] ?? "", w),
  );
  if (mismatch >= 0) {
    return {
      ok: false,
      evidence: `Sheet ${range}: col ${mismatch + 1} dice «${gotFirst[mismatch] ?? ""}», escribí «${want[mismatch]}»`,
    };
  }
  // Phase 2.3: matching what was written is not enough — the write must
  // also not contradict what the operator confirmed in chat.
  const rereadText = got
    .map((row) => (row ?? []).map((c) => String(c ?? "")).join(" | "))
    .join("\n");
  const contradiction = confirmedCheck(data, rereadText);
  if (contradiction) {
    return {
      ...contradiction,
      evidence: `Sheet ${range}: ${contradiction.evidence}`,
    };
  }
  return {
    ok: true,
    evidence: `Sheet ${range} (${got.length} fila${got.length === 1 ? "" : "s"}: ${gotFirst.slice(0, 4).join(" | ").slice(0, 80)})`,
  };
}

/** Google Docs: the document body contains the start of the text we inserted. */
export async function verifyDocWrite(
  data: Record<string, unknown>,
): Promise<ReadbackVerdict> {
  const docId = asString(data.document_id);
  const snippet = asString(data.snippet);
  const doc = await googleFetch<{
    title?: string;
    body?: {
      content?: Array<{
        paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
      }>;
    };
  }>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`);
  const text = (doc.body?.content ?? [])
    .flatMap((c) => c.paragraph?.elements ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (snippet && !norm(text).includes(norm(snippet))) {
    return {
      ok: false,
      evidence: `Doc «${doc.title ?? docId}»: no contiene el texto escrito (${norm(text).length} chars leídos)`,
    };
  }
  // Phase 2.3: the WRITE must not contradict operator-confirmed figures.
  // Scoped to the inserted text (R1 audit W1) — a pre-existing paragraph
  // elsewhere in the doc is not this write's claim. Falls back to the
  // snippet for gates declared before `written_text` existed.
  const contradiction = confirmedCheck(
    data,
    asString(data.written_text) || snippet,
  );
  if (contradiction) {
    return {
      ...contradiction,
      evidence: `Doc «${doc.title ?? docId}»: ${contradiction.evidence}`,
    };
  }
  return {
    ok: true,
    evidence: `Doc «${doc.title ?? docId}» (${norm(text).length} chars, empieza «${norm(snippet).slice(0, 40)}»)`,
  };
}

/** Scheduled task: the row exists, is active and carries the cron we set. */
export async function verifySchedule(
  data: Record<string, unknown>,
): Promise<ReadbackVerdict> {
  const id = asString(data.schedule_id);
  const row = getSchedule(id);
  if (!row)
    return { ok: false, evidence: `Schedule ${id.slice(0, 8)}: no existe` };
  if (!row.active)
    return { ok: false, evidence: `Schedule «${row.name}»: inactivo` };
  const cron = asString(data.cron_expr);
  if (cron && row.cron_expr !== cron) {
    return {
      ok: false,
      evidence: `Schedule «${row.name}»: cron ${row.cron_expr} ≠ ${cron}`,
    };
  }
  return {
    ok: true,
    evidence: `Schedule «${row.name}» activo (${row.cron_expr})`,
  };
}

export function registerReadbackVerifiers(): void {
  registerReadback("jarvis_file_write", verifyKbFile);
  registerReadback("jarvis_file_update", verifyKbFile);
  registerReadback("jarvis_files_batch_write", verifyKbFile);
  registerReadback("gsheets_write", verifySheetWrite);
  registerReadback("gdocs_write", verifyDocWrite);
  registerReadback("schedule_task", verifySchedule);
}
