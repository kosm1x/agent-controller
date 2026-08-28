/**
 * Artifact provenance gate — usability plan Phase 3.2 (2026-08-23).
 *
 * A figure written into an artifact (KB file, Google Sheet, Google Doc)
 * outlives the conversation: the 2026-08-22 review found Sheets contradicting
 * the model the operator had just confirmed (#11959), "34 stat rows" where 17
 * existed, 94 rows reported as 100 (#11898). Chat can carry a doubt inline
 * (`(sin verificar)`, numbers.ts); an artifact cannot — so the WRITE HANDLER
 * refuses a payload whose figures have no provenance.
 *
 * A figure is sourced when (any of):
 *   - its value appears in a READ-class tool result of THIS run (shell_exec,
 *     gsheets_read, web_read, market_quote, data_summarize, …) or in the
 *     user's own message (the router records it into the evidence corpus);
 *   - its block (paragraph / table row ± 1 line) carries `fuente:`, `calc:`,
 *     `supuesto:` or a URL;
 *   - (Sheets/Docs) the call passed a CHECKABLE `fuente` parameter (URL,
 *     path, or read-tool + query — "memoria" is not provenance) — recorded
 *     in the trace.
 * Everything else is rejected with a message that tells the model exactly
 * how to fix the payload — or to keep the figure in chat as unverified.
 *
 * This is a handler-level check on the structured payload, not a prompt
 * plea (plan §2 Phase 3.2). `PROVENANCE_GATE=shadow` logs without rejecting;
 * `off` disables; default `enforce`. Outside a run (no task id) nothing is
 * checked — scripts and tests that call tools directly are not gated.
 */

import { getDatabase } from "../../db/index.js";
import { emitTraceEvent } from "../../observability/task-trace.js";
import { currentRunTaskId, priorRunTools } from "../../tools/rule-of-two.js";
import {
  CHECKABLE_SOURCE_RE,
  auditNumbers,
  peekToolEvidence,
  stripForwardedSiblingFindings,
} from "./numbers.js";

export type ProvenanceMode = "off" | "shadow" | "enforce";

export function provenanceMode(
  env: NodeJS.ProcessEnv = process.env,
): ProvenanceMode {
  const v = (env.PROVENANCE_GATE ?? "enforce").trim().toLowerCase();
  return v === "off" || v === "shadow" ? v : "enforce";
}

export interface ProvenanceCheck {
  tool: string;
  /** `kb:<path>` / `sheet:<id>|<range>` / `doc:<id>` — for the trace. */
  artifact: string;
  /** Free text to check (KB content, Doc text, appended section). */
  text?: string;
  /** Sheet cells — every numeric cell is a figure. */
  cells?: unknown[][];
  /** Call-level provenance (Sheets/Docs `fuente` parameter). */
  fuente?: unknown;
  /**
   * Content the artifact ALREADY had (full-file rewrite): figures that were
   * there before are not new claims of this run (R3 audit W-7).
   */
  priorContent?: string | null;
}

export interface ProvenanceVerdict {
  ok: boolean;
  figures: number;
  unsourced: string[];
  /** JSON error string for the tool result when rejected. */
  error?: string;
}

const MAX_LISTED = 5;

/**
 * Sheet cells that are NOT figures: dates, formulas, years, zip codes and
 * other leading-zero codes, long digit strings (phones, ids, folios),
 * mixed ids. Everything else numeric is a claim — in a sheet a bare `94`
 * is a statistic, so it is rendered as `94 registros` for the detector.
 */
export function cellIsFigure(cell: unknown): boolean {
  if (typeof cell === "number") {
    return Number.isFinite(cell) && !(Number.isInteger(cell) && cell >= 1900 && cell <= 2099);
  }
  if (typeof cell !== "string") return false;
  const s = cell.trim();
  if (!s || s.startsWith("=")) return false; // formulas are computed by Sheets
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s))
    return false; // dates
  if (/^(19|20)\d{2}$/.test(s)) return false; // years
  if (/^0\d+$/.test(s)) return false; // zip / leading-zero codes
  if (/^\d{8,}$/.test(s)) return false; // phones, folios, numeric ids
  return /^[$€£]?\s?-?\(?\d[\d,.]*\)?\s?(?:%|[kKMB]|USD|MXN)?$/.test(s);
}

/**
 * One text block per ROW (blank-line separated) so a `fuente:` cell sources
 * its own row only (R1 audit C5); numeric cells become `<n> registros`.
 */
function cellsToText(cells: unknown[][]): string {
  return cells
    .map((row) =>
      (Array.isArray(row) ? row : [row])
        .map((c) => {
          const s = c === null || c === undefined ? "" : String(c);
          return cellIsFigure(c) && !/[%$€£]|\b(?:[kKMB]|USD|MXN)\b/.test(s)
            ? `${s} registros`
            : s;
        })
        .join(" | "),
    )
    .join("\n\n");
}

/**
 * The task description is evidence for a SCHEDULED task (the ritual prompt
 * carries its own figures). For a chat task it is the ~24 KB persona
 * prompt — the user's message arrives via `recordUserEvidence` instead, so
 * the persona is skipped (R3 audit W-5: it "rescued" persona percentages).
 */
function taskDescription(taskId: string): string {
  try {
    const row = getDatabase()
      .prepare(`SELECT description FROM tasks WHERE task_id = ?`)
      .get(taskId) as { description?: string } | undefined;
    const d = row?.description ?? "";
    // A swarm child's description ends with runner-authored sibling
    // sections (status slices, forwarded findings) — prose, not evidence
    // (qa-audit R3 C2).
    return /^\s*## Identidad/.test(d) ? "" : stripForwardedSiblingFindings(d);
  } catch {
    return "";
  }
}

/** A read-tool name in a `fuente` must name a tool that actually RAN this turn (R3 audit C-3). */
/**
 * UNANCHORED on purpose — it must mirror the admitter (`CHECKABLE_SOURCE_RE`
 * also matches a tool name anywhere in the value): "**Fuente:** \`shell_exec
 * wc -l\`" or "salida de data_summarize x.csv" name a tool too (R4 audit C4-1).
 */
const TOOL_NAME_RE =
  /\b(shell_exec|gsheets_read|gdocs_read(?:_full)?|gdrive_\w+|web_read|web_search|exa_search|file_read|data_summarize|pdf_read|http_fetch|market_\w+|prediction_markets|crm_query|intel_\w+|jarvis_file_read|task_history|code_search|[\w-]+__\w+)\b/i;

export function fuenteIsCheckable(rawFuente: string): boolean {
  if (!CHECKABLE_SOURCE_RE.test(rawFuente)) return false;
  const tool = TOOL_NAME_RE.exec(rawFuente)?.[1];
  if (!tool) return true; // URL / path / named data source — a stranger can check it
  const ran = priorRunTools();
  return ran !== undefined && ran.some((t) => t.toLowerCase() === tool.toLowerCase());
}

function rejectionMessage(
  tool: string,
  unsourced: readonly string[],
  hasFuenteParam: boolean,
  badFuente: string,
): string {
  const listed = unsourced
    .slice(0, MAX_LISTED)
    .map((f) => `«${f}»`)
    .join(", ");
  const more =
    unsourced.length > MAX_LISTED
      ? ` y ${unsourced.length - MAX_LISTED} más`
      : "";
  const checkable =
    "una URL, una ruta de archivo, o el nombre de la herramienta de lectura con su consulta (p. ej. `shell_exec wc -l ventas.csv`, `gsheets_read Ventas!A:F`, `web_read https://…`)";
  const how = hasFuenteParam
    ? `pasa el parámetro \`fuente\` con ${checkable}, o pon en la MISMA fila una celda \`fuente: <eso>\`, \`calc: <expresión>\` o \`supuesto: <por qué>\``
    : `en el MISMO párrafo o fila escribe \`fuente: <${checkable}>\`, \`calc: <expresión>\` o \`supuesto: <por qué>\``;
  const bad = badFuente
    ? ` «fuente: ${badFuente}» no es verificable — "memoria", "análisis propio", un nombre suelto, o una herramienta que NO corriste en este turno no cuentan.`
    : "";
  return JSON.stringify({
    error: `Escritura rechazada (${tool}): ${unsourced.length} cifra${unsourced.length === 1 ? "" : "s"} sin procedencia — ${listed}${more}. Ninguna aparece en los resultados de herramientas de lectura de esta corrida ni en el mensaje del usuario.${bad} Para escribirla, ${how}. Si la cifra viene de tu memoria y no la puedes respaldar, NO la escribas en el archivo: menciónala en el chat como «~X (sin verificar)».`,
    unsourced: unsourced.slice(0, 20),
  });
}

/**
 * Check one artifact payload. Never throws; on an internal failure the write
 * proceeds (a provenance hiccup must not lose a deliverable) and the trace
 * records the error.
 */
export function checkArtifactProvenance(
  input: ProvenanceCheck,
  env: NodeJS.ProcessEnv = process.env,
): ProvenanceVerdict {
  const mode = provenanceMode(env);
  const taskId = currentRunTaskId();
  if (mode === "off" || !taskId) {
    return { ok: true, figures: 0, unsourced: [] };
  }
  try {
    const text = [input.text ?? "", input.cells ? cellsToText(input.cells) : ""]
      .filter(Boolean)
      .join("\n\n");
    const rawFuente =
      typeof input.fuente === "string" ? input.fuente.trim() : "";
    // Call-level provenance counts only when a stranger could check it.
    const fuente = fuenteIsCheckable(rawFuente) ? rawFuente : "";
    const corpus = [
      ...peekToolEvidence(taskId),
      taskDescription(taskId),
      input.priorContent ?? "",
    ];
    // Code blocks are NOT exempt in an artifact (R2 audit W-1).
    const audit = auditNumbers(text, corpus, {
      includeCode: true,
      sourceOk: fuenteIsCheckable,
    });
    const unsourced = fuente ? [] : audit.unverified;
    const rejected = mode === "enforce" && unsourced.length > 0;
    emitTraceEvent({
      taskId,
      name: "provenance.checked",
      tool: input.tool,
      attrs: {
        artifact: input.artifact.slice(0, 120),
        figures: audit.found.length,
        unsourced: unsourced.length,
        fuente: fuente ? fuente.slice(0, 80) : undefined,
        mode,
        rejected,
      },
    });
    if (rejected) {
      return {
        ok: false,
        figures: audit.found.length,
        unsourced,
        error: rejectionMessage(
          input.tool,
          unsourced,
          "fuente" in input,
          rawFuente && !fuente ? rawFuente.slice(0, 40) : "",
        ),
      };
    }
    return { ok: true, figures: audit.found.length, unsourced };
  } catch (err) {
    emitTraceEvent({
      taskId,
      name: "provenance.checked",
      tool: input.tool,
      attrs: { error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: true, figures: 0, unsourced: [] };
  }
}
