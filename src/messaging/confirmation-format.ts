/**
 * Confirmation formatting for gated actions: whether an approved call's
 * result counts as a failure, the result line the operator reads for it, the
 * confirmation card under the reply and the exact-literal answer a card of
 * several items takes.
 *
 * Pure functions over their arguments, with no conversation state. This
 * module must not import the message router: the router imports these names
 * and re-exports the public ones for its existing callers, so an import back
 * would make the two a cycle.
 */
import { safeSlice } from "../lib/unicode-safe.js";
import {
  CONFIRMATION_LIST_MAX,
  type PendingCall,
} from "../inference/execution-context.js";
import { sanitizeToolResult } from "../inference/guards.js";

/**
 * Tools whose failure can be `{error: <response body>}` with an empty body
 * (key present, value falsy) and whose successes never carry the key. Not
 * every tool: a remote tool's JSON success may carry `"error": null`.
 */
const EMPTY_ERROR_FAILURE_TOOLS: ReadonlySet<string> = new Set([
  "wp_delete",
  "wp_raw_api",
]);

/**
 * Tools whose `{ok: false}` envelope is a failure without an `error` key
 * (the skill runner). Not every tool: a remote JSON success may carry
 * `"ok": false` as data.
 */
const OK_FALSE_FAILURE_TOOLS: ReadonlySet<string> = new Set(["skill_run"]);

/**
 * The failure text of a confirmed call's result, or null when the call
 * succeeded by its tool's own convention. A failure stops the card exactly
 * like `{error}` does: later items are declined and the original request is
 * not resumed, so a failed action is never shown as done.
 * - JSON `{error: truthy}` (every tool);
 * - JSON with the `error` key but a falsy value (EMPTY_ERROR_FAILURE_TOOLS);
 * - JSON `{ok: false}` (OK_FALSE_FAILURE_TOOLS);
 * - the development tool's test action with checks that did not pass or did
 *   not run (`ready_for_pr: false`), the batch delete with a failed deletion
 *   (`success: false`), the memory forget whose correction was not deleted;
 * - text that leads with the cross mark or the word `Error` (the same
 *   markers the registry counts as an error result). Other text is success:
 *   remote tools and several local tools answer in plain text.
 */
export function confirmedActionFailure(toolName: string, result: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return /^\s*(?:❌|Error\b)/.test(result) ? result.trim() : null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.error) return String(obj.error);
  if ("error" in obj && EMPTY_ERROR_FAILURE_TOOLS.has(toolName)) {
    return String(obj.http_status ?? obj.error);
  }
  if (obj.ok === false && OK_FALSE_FAILURE_TOOLS.has(toolName)) {
    return String(obj.errorDetail || obj.errorClass);
  }
  if (toolName === "jarvis_dev" && obj.ready_for_pr === false) {
    // Each check that did not pass, as the gate reported it: one line, capped.
    return (["typecheck", "tests"] as const)
      .filter((k) => !/^(PASS|SKIPPED)/.test(String(obj[k])))
      .map((k) => `${k}: ${plainResultDetail(toolName, { message: String(obj[k]) }) ?? ""}`)
      .join("; ");
  }
  if (toolName === "jarvis_files_batch_delete" && obj.success === false) {
    const nf = Number(obj.not_found ?? 0);
    return [
      `${obj.ok ?? 0} archivo(s) eliminado(s)`,
      ...(nf > 0 ? [`${nf} no encontrado(s)`] : []),
      `${obj.errors ?? 0} error(es)`,
    ].join("; ");
  }
  if (toolName === "memory_forget" && obj.correction_deleted === false) {
    return [
      ...(typeof obj.invalidated === "number" ? [`${obj.invalidated} hecho(s) invalidado(s)`] : []),
      String(obj.correction_error),
    ].join("; ");
  }
  return null;
}

/** Format a human-readable confirmation result based on tool name. */
export function formatConfirmationResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  switch (toolName) {
    case "gmail_send":
      return `✅ Correo enviado a ${args.to ?? "destinatario"}.\nAsunto: ${args.subject ?? "(sin asunto)"}`;
    case "calendar_create":
    case "calendar_update":
      return `✅ Evento ${toolName === "calendar_create" ? "creado" : "actualizado"}: ${args.title ?? args.summary ?? "evento"}`;
    case "gdrive_delete":
      return `✅ Archivo eliminado de Drive.`;
    case "gdrive_move":
      return `✅ Archivo movido en Drive.`;
    case "gdrive_share":
      return `✅ Archivo compartido${args.email ? ` con ${args.email}` : ""}.`;
    case "wp_publish":
      return `✅ Publicado en WordPress: ${(result as Record<string, unknown>).title ?? args.title ?? "post"}`;
    case "wp_delete":
      return `✅ Post eliminado de WordPress.`;
    case "file_delete":
      return `✅ Archivo eliminado: ${args.path ?? ""}`;
    case "jarvis_file_delete":
      return `✅ Archivo eliminado: ${args.path ?? ""}`;
    case "jarvis_files_batch_delete": {
      const ok = (result as { ok?: number }).ok ?? 0;
      const nf = (result as { not_found?: number }).not_found ?? 0;
      const err = (result as { errors?: number }).errors ?? 0;
      const parts = [`✅ ${ok} archivo(s) eliminado(s)`];
      if (nf > 0) parts.push(`${nf} no encontrado(s)`);
      if (err > 0) parts.push(`${err} error(es)`);
      return parts.join("; ") + ".";
    }
    case "jarvis_files_batch_write": {
      const ok = (result as { ok?: number }).ok ?? 0;
      const err = (result as { errors?: number }).errors ?? 0;
      return err > 0
        ? `✅ ${ok} archivo(s) escrito(s); ${err} error(es).`
        : `✅ ${ok} archivo(s) escrito(s).`;
    }
    case "delete_schedule":
      return `✅ Schedule eliminado.`;
    case "run_schedule":
      // Started, not finished: the tool's message says where the result lands.
      return `✅ ${result.message ?? "Ejecución iniciada."}`;
    case "google_workspace_cli":
      return formatGwsConfirmationResult(args, result);
    default: {
      const base = `✅ ${toolName} ejecutado correctamente.`;
      const detail = plainResultDetail(toolName, result);
      return detail ? `${base} ${detail}` : base;
    }
  }
}

/** Max chars of a plain result's message appended to the default line. */
const PLAIN_RESULT_DETAIL_MAX = 120;

/**
 * Queue 4l (ruling b): the default line may carry the tool's own short
 * message — only for a plain `{ok|status|message}` result of primitives,
 * never raw content; sanitized (sanitizeToolResult), one line, capped.
 */
function plainResultDetail(
  toolName: string,
  result: Record<string, unknown>,
): string | null {
  const keys = Object.keys(result);
  const plain =
    keys.length > 0 &&
    keys.every(
      (k) =>
        (k === "ok" || k === "status" || k === "message") &&
        ["string", "number", "boolean"].includes(typeof result[k]),
    );
  if (!plain) return null;
  const text =
    typeof result.message === "string"
      ? result.message
      : typeof result.status === "string"
        ? result.status
        : "";
  const line = safeSlice(
    sanitizeToolResult(toolName, text).replace(/\s+/g, " ").trim(),
    PLAIN_RESULT_DETAIL_MAX,
  );
  return line.length > 0 ? line : null;
}

/**
 * Queue 4l (ruling b): what a confirmed gws call did, from the parsed gws
 * JSON (`{ok, result}`). A Docs batchUpdate reports how many changes landed
 * — Σ `replaceAllText.occurrencesChanged` (absent = 0, as the API omits a
 * zero) plus one per other reply — and says so plainly when a replace
 * matched nothing. Facts only (counts, an id), never document content.
 */
function formatGwsConfirmationResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  const out = result.result;
  const body =
    out && typeof out === "object" && !Array.isArray(out)
      ? (out as Record<string, unknown>)
      : {};
  const replies = Array.isArray(body.replies) ? (body.replies as unknown[]) : null;
  const resource = typeof args.resource === "string" ? args.resource : "";
  if (
    args.service === "docs" &&
    resource === "documents" &&
    args.method === "batchUpdate" &&
    replies
  ) {
    let changes = 0;
    let replaced = false;
    let unmatched = 0;
    for (const reply of replies) {
      const rat =
        reply && typeof reply === "object"
          ? (reply as Record<string, unknown>).replaceAllText
          : undefined;
      if (rat && typeof rat === "object") {
        replaced = true;
        const n = (rat as { occurrencesChanged?: unknown }).occurrencesChanged;
        const hits = typeof n === "number" && Number.isFinite(n) ? n : 0;
        changes += hits;
        if (hits === 0) unmatched += 1;
      } else {
        changes += 1;
      }
    }
    if (replaced && changes === 0) return "⚠️ Doc sin cambios: 0 coincidencias";
    // qa R1 W3: a replace that matched nothing is named even when others landed.
    const missed =
      unmatched > 0 ? ` (${unmatched} reemplazo(s) sin coincidencias)` : "";
    return `✅ Doc actualizado: ${changes} cambios aplicados${missed}`;
  }
  const words = [args.service, ...resource.split("."), args.method]
    .filter((w) => typeof w === "string" && w.length > 0)
    .map((w) => String(w).replace(/[`\r\n]/g, ""));
  const line = `✅ ${words.join(" ")} ejecutado`;
  if (replies) return `${line} (${replies.length} respuesta(s))`;
  if (typeof body.id === "string" && body.id.length > 0) {
    return `${line} (id ${safeSlice(body.id.replace(/[`\r\n]/g, ""), 80)})`;
  }
  return line;
}

/** Queue 4l: the card line stays well inside one Telegram message (4096). */
export const CONFIRM_CARD_MAX = 3500;

/**
 * W1 (audit 2026-09-30) + queue 4l: the card line(s) under the reply, from
 * the harness summaries of the STORED args, in run order. One item keeps the
 * pre-4l wording; N items are numbered, each clipped further only when the
 * whole card would pass CONFIRM_CARD_MAX.
 */
export function renderConfirmationCard(summaries: readonly string[]): string {
  if (summaries.length === 1) {
    return `🔐 Si confirmas, se ejecutará exactamente: \`${summaries[0]}\``;
  }
  const head = `🔐 Si confirmas, se ejecutarán exactamente (${summaries.length}):`;
  const tail = partialReplyRefusal(summaries.length);
  const line = (s: string, i: number) => `${i + 1}. \`${s}\``;
  const full = [head, ...summaries.map(line), tail].join("\n");
  if (full.length <= CONFIRM_CARD_MAX) return full;
  const room = Math.max(
    20,
    Math.floor(
      (CONFIRM_CARD_MAX - head.length - tail.length) / summaries.length,
    ) - 8,
  );
  return [
    head,
    ...summaries.map((s, i) =>
      line(s.length > room ? `${safeSlice(s, room)}…` : s, i),
    ),
    tail,
  ].join("\n");
}

/**
 * qa R1 C1 + ruling a: one yes runs the whole card, so a card of N>1 items
 * takes only an exact literal (isWholeCardLiteral). Shown as the card's last
 * line and as the reply to ANY other message while the card is pending — a
 * new request then needs «no» first; the card never lapses into a new turn.
 */
export function partialReplyRefusal(n: number): string {
  return `Responde exactamente «sí» (o «sí a todo») para ejecutar las ${n} acciones, o «no» para ninguna; esta tarjeta no admite respuestas parciales.`;
}

/**
 * qa R3 C1 + operator ruling a (2026-10-18, 3-strike stop on parsing the
 * reply): a card of N>1 items is answered with an EXACT LITERAL. The reply
 * is only normalized (group prefix, trim, accents, case, inner whitespace),
 * never parsed: no punctuation or emoji stripping, no verb vocabulary.
 * Anything outside the closed sets is null — the caller refuses it.
 */
export function isWholeCardLiteral(
  text: string,
  n: number,
): "yes" | "no" | null {
  const reply = text
    .trim()
    .replace(/^\[Grupo:.*?\]\n?/i, "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  const yes = ["si", "si a todo", `si a las ${n}`, `si a los ${n}`, "ok"];
  if (yes.includes(reply)) return "yes";
  if (reply === "no") return "no";
  return null;
}

/** qa R1 W6: max chars of the stored summary shown in a result line's label. */
const RESULT_LABEL_TARGET_MAX = 40;

/**
 * qa R1 W6: `<tool> <target-ish>` for a card item's result line — the first
 * RESULT_LABEL_TARGET_MAX chars of the STORED summary after the tool name
 * (already shown on the card, already W1-safe).
 */
export function resultLabel(item: { toolName: string; summary: string }): string {
  let rest = item.summary.startsWith(item.toolName)
    ? item.summary.slice(item.toolName.length)
    : item.summary;
  // A gws summary leads with `(gws <service> <resource> <method> --params `,
  // the same for every item of a batch: its target starts at the params.
  const params = rest.indexOf(" --params ");
  if (item.toolName === "google_workspace_cli" && params >= 0) {
    rest = rest.slice(params + " --params ".length);
  }
  const target = rest.replace(/^[\s(:]+/, "");
  const shown =
    target.length > RESULT_LABEL_TARGET_MAX
      ? `${safeSlice(target, RESULT_LABEL_TARGET_MAX)}…`
      : target;
  return shown.length > 0 ? `${item.toolName} ${shown}` : item.toolName;
}

/**
 * The gated calls of a run's `pendingConfirmation` output (queue 4l `items`,
 * or the pre-4l single call), shape-checked and capped.
 */
export function pendingCallsOf(p: {
  toolName: string;
  args: Record<string, unknown>;
  items?: unknown;
}): PendingCall[] {
  const isCall = (c: unknown): c is PendingCall =>
    !!c &&
    typeof (c as PendingCall).toolName === "string" &&
    !!(c as PendingCall).args &&
    typeof (c as PendingCall).args === "object" &&
    !Array.isArray((c as PendingCall).args);
  const items = Array.isArray(p.items) ? p.items.filter(isCall) : [];
  const calls = items.length > 0 ? items : isCall(p) ? [p] : [];
  return calls.slice(0, CONFIRMATION_LIST_MAX);
}
