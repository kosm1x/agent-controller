/**
 * Deliverable filter — the last gate before LLM text reaches a phone.
 *
 * Phase 0.1 of docs/planning/jarvis-usability-plan-2026-08-22.md. The
 * 2026-08-22 critic review counted ~25 raw harness strings, ~15 English-first
 * replies and 4 empty replies delivered to Telegram in 45 days: the runner's
 * internal markers (`[error_max_turns — …] Partial response below`, `STATUS:
 * DONE_WITH_CONCERNS`, `[timeout after 900s — …]`), sub-agent narration
 * (`I'll verify…`, `Goal completed ✅`) and glued process prose (`Tengo el
 * contexto. Ahora escribo…Tengo suficiente…`) all survive `parseRunnerStatus`
 * (which strips only the TRAILING STATUS line) and land on the user.
 *
 * Pure function, no I/O. Applied at every router send seam
 * (`sendLLMReplyToChannel`, the streaming finalize, `broadcastToAll`,
 * `sendBriefingToOwner`). Idempotent: a second pass over its own output is a
 * no-op (R1 audit: 0 non-idempotent over 379 real replies).
 *
 * Deliberately narrow — the R1 qa-audit (2026-08-23) replayed the live
 * corpus and found the first cut truncating filenames mid-token and asserting
 * failures on replies that merely QUOTED an error. Hence:
 *   - markers are matched at line start (or in the exact SDK shape), never
 *     mid-sentence, and never inside fenced code;
 *   - narration sentences end only at a terminator followed by whitespace/EOS
 *     (or an ellipsis), so `index.html` cannot end a sentence;
 *   - the "≥ 80 chars of content must remain" guard is measured without our
 *     own appended failure line.
 * It never rewrites content and never translates — a fully-English reply is
 * flagged (`englishLeading`) for the metrics script, not altered.
 */

import { isLedgerLine } from "../lib/v8-4/ledger-lines.js";

export type FailureKind =
  "turn_budget" | "timeout" | "auth" | "api_error" | "task_failed";

export interface SanitizeResult {
  /** Text safe to deliver. May be empty only when the raw text was empty. */
  text: string;
  /** Labels of everything removed, for logs/metrics. */
  stripped: string[];
  /** A harness failure was detected in the raw text. */
  failureKind?: FailureKind;
  /** The delivered text opens in English on a Spanish surface. */
  englishLeading: boolean;
  /** Present when the filter appended a user-facing failure line (it is the LAST line of `text`). */
  failureLine?: string;
}

/** Schedule pause sentinel (Phase 0.3) — consumed by the scheduler, never shown. */
export const PAUSE_SCHEDULE_TAG = "[PAUSAR-SCHEDULE]";

// --- harness markers (line-anchored) ---------------------------------------

/** `[error_max_turns — Reached maximum number of turns (55)] Partial response below — turn/budget limit hit before completion.` */
const SDK_ERROR_MARKER_RE =
  /^[ \t]*\[(error_max_turns|error_max_budget_usd|error_during_execution|error_max_structured_output_retries)[^\]\n]*\](?:[ \t]*Partial response below[^\n]*)?/gm;
/** `[timeout after 900s — partial response below]` */
const TIMEOUT_MARKER_RE = /^[ \t]*\[timeout after \d+s[^\]\n]*\]/gm;
/** `STATUS: DONE_WITH_CONCERNS — …` on its own line (parseRunnerStatus strips only the tail). */
const STATUS_LINE_RE =
  /^[ \t]*STATUS:\s*(?:DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|DONE)\b[^\n]*$/gm;
/** Router/runner failure placeholders that are records, not replies. */
const FAILED_PLACEHOLDER_RE =
  /^[ \t]*(?:\[Task failed\][^\n]*|\[Task cancelled[^\]\n]*\])/gm;
/** Thread-buffer record that is not a reply at all. */
const ACK_PLACEHOLDER_RE = /^[ \t]*\[positive feedback acknowledged\][ \t]*$/gm;
/** Sub-agent goal banners on their own line: `Goal completed ✅`, `Goal completado ✅.` */
const GOAL_BANNER_RE = /^[ \t]*(?:#+\s*)?Goal complet(?:ed|ado)\b[^\n]*$/gim;
/** `Failed to authenticate. API Error: 401 OAuth access token has been revoked` — own line only. */
const AUTH_FAILURE_RE =
  /^[ \t]*(?:Failed to authenticate\b|API Error:\s*401\b|OAuth (?:access )?token has been revoked|OAuth session expired)[^\n]*/gm;
/**
 * Non-401 API errors: own line, OR the exact SDK shape glued to prose — a
 * status code followed by a JSON body (`API Error: 400 {"type":"error",…}`,
 * the 2026-08-21 content-filter case that arrived without a newline).
 */
const API_ERROR_RE =
  /(?:^[ \t]*API Error:\s*(\d{3})\b[^\n]*|API Error:\s*(\d{3})\s*\{[^\n]*)/gm;

// --- narration -------------------------------------------------------------

/**
 * Leading process-narration sentences. Matched only at the START of the text,
 * only when SHORT (≤ 110 chars each) and only when ≥ 80 chars of content
 * remain afterwards — a reply that IS a short plan ("Voy a hacer X, ¿ok?")
 * is left alone.
 *
 * A sentence ends at `.!?` followed by whitespace/EOS, or at an ellipsis.
 * A dot glued to a lowercase letter or digit (`index.html`, `v1.2`) is part
 * of a token and does not end the sentence (R1 audit C1); glued to anything
 * else — an uppercase letter (`páginas.Tengo`), an emoji (`inversión.✅
 * Tesis…`) — it is the streamed-seam boundary and does (corpus replays
 * 68844711 "sistema.No hay ningún…" and dd7d5c05 "inversión.✅ Tesis
 * actualizada…", both of which must keep the second sentence).
 */
const NARRATION_SENTENCE_RE =
  /^\s*(?:Voy a|Ahora (?:leo|creo|escribo|reviso|verifico|busco|ejecuto|paso|hago|actualizo|genero|corro|sigo|lo)|Tengo (?:suficiente|todo|el contexto|la info|los datos)|Déjame|Primero (?:leo|reviso|verifico|busco)|Empiezo|Procedo|Escribo|Creo el|Genero|Actualizo|Consulto|Leo el|Reviso el|Verifico (?:el|la|si|que)|Busco|Ejecuto|I'll|I will|Let me|Now I|First,? I|I need to|I'm going to)\b(?:[^.!?\n:]|[.!?](?=[a-z0-9à-öø-ÿ])){0,110}?(?:[.!?…]{2,}|[.!?…](?![a-z0-9à-öø-ÿ.!?…])|\n)\s*/;
const MAX_NARRATION_SENTENCES = 20;

/**
 * Ritual preamble: an agent-to-itself run log ("I'll execute the ritual in
 * sequence. Schemas loaded. Now executing Step 1 — …Ahora ejecuto Step 3.---")
 * glued before the first markdown block of the actual report (R1 audit W4).
 * Dropped only when a structural separator follows within 600 chars AND the
 * preamble reads as a run log.
 */
const REPORT_START_RE = /(?:^|\n)(?:---[ \t]*\n|#{1,3} |\*\*)/;
const RUN_LOG_RE =
  /\b(?:Step \d|Ejecutando|Procediendo|Ahora ejecuto|Schemas loaded|Executing|I'll|Let me)\b/;
const MAX_PREAMBLE = 600;

// --- language heuristic ----------------------------------------------------

const EN_MARKERS =
  /\b(?:the|and|with|this|that|I'll|let me|here's|you|your|file|verify|check|summary|found|now|will)\b/gi;
const ES_MARKERS =
  /\b(?:el|la|los|las|de|que|para|con|una|está|aquí|hoy|ya|sí|tengo|listo|esto|eso)\b/gi;

function looksEnglish(head: string): boolean {
  const en = (head.match(EN_MARKERS) ?? []).length;
  const es = (head.match(ES_MARKERS) ?? []).length;
  return en >= 4 && en > es * 2;
}

// --- failure lines (Spanish, one line + next step) -------------------------

const LINES = {
  turn_budget_partial:
    "Se me acabó el presupuesto del turno antes de terminar — lo de arriba es lo que alcancé. Dime «sigue» para continuar.",
  turn_budget_empty:
    "Se me acabó el presupuesto del turno antes de producir resultado. Dime «sigue» para reintentar.",
  timeout_partial:
    "La tarea se cortó por tiempo — lo de arriba es parcial. ¿Sigo desde donde quedó?",
  timeout_empty:
    "La tarea se cortó por tiempo antes de producir resultado. ¿La reintento?",
  auth: "Se venció la sesión de autenticación (OAuth). Reintenta en unos minutos; si persiste, hay que renovar el token.",
  task_failed: "No pude completar eso. ¿Lo reintento?",
  empty: "No me quedó una respuesta utilizable de ese turno. ¿Lo reintento?",
} as const;
const API_LINE_RE = /^La API devolvió un error \S+\. ¿Reintento\?$/;

function failureLine(kind: FailureKind, hasContent: boolean, code?: string) {
  switch (kind) {
    case "turn_budget":
      return hasContent ? LINES.turn_budget_partial : LINES.turn_budget_empty;
    case "timeout":
      return hasContent ? LINES.timeout_partial : LINES.timeout_empty;
    case "auth":
      return LINES.auth;
    case "api_error":
      return `La API devolvió un error ${code ?? "desconocido"}. ¿Reintento?`;
    case "task_failed":
      return LINES.task_failed;
  }
}

/** Is this one of our own appended lines? (keeps the content guard idempotent) */
function isOwnLine(line: string): boolean {
  const t = line.trim();
  return (
    (Object.values(LINES) as string[]).includes(t) ||
    API_LINE_RE.test(t) ||
    // Every line the V8.4 completion ledger can append.
    isLedgerLine(t)
  );
}

// --- fenced-code awareness -------------------------------------------------

/** Apply `fn` to the text OUTSIDE ``` fences only; code is returned verbatim. */
function outsideCode(text: string, fn: (seg: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/);
  for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
  return parts.join("");
}

// ---------------------------------------------------------------------------

export function sanitizeDeliverable(raw: string): SanitizeResult {
  const stripped: string[] = [];
  let text = raw ?? "";
  let failureKind: FailureKind | undefined;
  let apiCode: string | undefined;

  const cut = (re: RegExp, label: string, onHit?: () => void): void => {
    let hit = false;
    text = outsideCode(text, (seg) => {
      re.lastIndex = 0;
      if (!re.test(seg)) return seg;
      hit = true;
      re.lastIndex = 0;
      return seg.replace(re, "");
    });
    if (hit) {
      stripped.push(label);
      onHit?.();
    }
  };

  cut(SDK_ERROR_MARKER_RE, "sdk_error_marker", () => {
    failureKind ??= "turn_budget";
  });
  cut(TIMEOUT_MARKER_RE, "timeout_marker", () => {
    failureKind ??= "timeout";
  });
  // Auth / API errors name the CAUSE; a turn/timeout marker is usually the
  // consequence — so these override rather than defer.
  cut(AUTH_FAILURE_RE, "auth_failure", () => {
    failureKind = "auth";
  });
  {
    let code: string | undefined;
    text = outsideCode(text, (seg) => {
      API_ERROR_RE.lastIndex = 0;
      return seg.replace(API_ERROR_RE, (_m, a?: string, b?: string) => {
        const c = a ?? b;
        if (c && c !== "401") code ??= c;
        return "";
      });
    });
    if (code) {
      apiCode = code;
      stripped.push("api_error");
      failureKind = "api_error";
    }
  }
  cut(FAILED_PLACEHOLDER_RE, "failed_placeholder", () => {
    failureKind ??= "task_failed";
  });
  cut(ACK_PLACEHOLDER_RE, "ack_placeholder");
  cut(STATUS_LINE_RE, "status_line");
  cut(GOAL_BANNER_RE, "goal_banner");
  if (text.includes(PAUSE_SCHEDULE_TAG)) {
    text = text.split(PAUSE_SCHEDULE_TAG).join("");
    stripped.push("pause_tag");
  }

  // Content that must survive the narration peel: everything except a
  // trailing line we appended on an earlier pass.
  const contentLength = (s: string): number => {
    const lines = s.trim().split("\n");
    while (lines.length && isOwnLine(lines[lines.length - 1])) lines.pop();
    return lines.join("\n").trim().length;
  };

  // Ritual run-log preamble before the first markdown block.
  {
    const m = REPORT_START_RE.exec(text);
    if (m && m.index > 0 && m.index <= MAX_PREAMBLE) {
      const pre = text.slice(0, m.index);
      // A preamble carrying a bold headline or its own paragraphs is content
      // (corpus replay ce948187: "✅ **KB de Pulso Aura actualizado**" before
      // the "## Delta" block) — never dropped.
      const isRunLog =
        RUN_LOG_RE.test(pre) && !/\*\*|\n\n/.test(pre.trim());
      if (isRunLog && contentLength(text.slice(m.index)) >= 80) {
        text = text.slice(m.index).replace(/^\s*---[ \t]*\n/, "");
        stripped.push("preamble");
      }
    }
  }

  // Leading narration: peel short process sentences while real content remains.
  let peeled = 0;
  for (;;) {
    if (peeled >= MAX_NARRATION_SENTENCES) break;
    const m = NARRATION_SENTENCE_RE.exec(text);
    if (!m) break;
    const rest = text.slice(m[0].length);
    if (contentLength(rest) < 80) break;
    text = rest;
    peeled++;
  }
  if (peeled > 0) stripped.push(`narration:${peeled}`);

  // Collapse the whitespace holes the cuts leave behind.
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[—-]\s*$/gm, "")
    .trim();

  const hasContent = contentLength(text) > 0;
  let line: string | undefined;
  if (failureKind) {
    line = failureLine(failureKind, hasContent, apiCode);
    text = hasContent ? `${text}\n\n${line}` : line;
  } else if (text.length === 0 && raw.trim().length > 0) {
    // Markers-only input with no recognised failure: never deliver silence.
    line = LINES.empty;
    text = line;
    stripped.push("empty_after_strip");
  }

  const englishLeading = looksEnglish(text.slice(0, 300));

  return { text, stripped, failureKind, englishLeading, failureLine: line };
}
