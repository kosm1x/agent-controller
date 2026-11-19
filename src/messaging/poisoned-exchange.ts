/**
 * The poison check for thread exchanges: the patterns of a reply that must
 * not be replayed to the model as context, and the predicate over them.
 *
 * A leaf module: it imports nothing. The open-work notes apply the check
 * from here, so they do not have to load the message router, which imports
 * them back. The router re-exports `isPoisonedExchange` for its existing
 * callers.
 */

/**
 * Tool refusals (LLM claims it can't use available tools). Queue 4g
 * (2026-10-17): the ONLY family a verified exchange (its task ran a tool or
 * met a harness gate) skips — over the prior 30 days the first pattern made
 * 12/12 push-time blocks, every one on a task that had run tools (3 with
 * harness gates met): a sentence inside a real success report, not the
 * zero-tool whole-reply refusal this family exists for. That false-positive
 * class is handled by the evidence gate, so the patterns stay un-anchored and
 * still catch every zero-tool refusal ("Lo siento, no tengo acceso a …").
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /no tengo (?:acceso|(?:la|una|ninguna)\s+herramienta|herramienta)/i,
  /no tengo disponible/i,
  /no tengo.*(?:wp_|gmail_|gsheets_)/i,
  /no tengo.*wp_publish/i,
  /no pude completar la acci[oó]n/i,
  /no (?:puedo|es posible) (?:renombrar|cambiar el nombre|actualizar el nombre)/i,
  /necesitas? hacer.{0,20}(?:manualmente|desde la interfaz)/i,
];

/**
 * Detect poisoned exchanges — hallucinated success, system errors, or
 * refusals that teach the LLM learned helplessness if kept in context.
 */
const POISONED_RESPONSE_PATTERNS = [
  // Hallucinated success without tool calls
  /estoy alucinando/i,
  /est[aá]s alucinando/i,
  /narr(?:ando|é) acciones sin ejecutar/i,
  // Lazy acknowledgments — claimed action "in process" without executing.
  // These teach the LLM to plan instead of execute.
  // IMPORTANT: limit .{0,80} span — ✅ followed much later by "en progreso"
  // in a status report (e.g. "10 tareas en progreso") is NOT lazy acknowledgment.
  /✅.{0,80}(?:en proceso|en curso|iniciando|comenzando)\b/i,
  /✅.{0,80}(?:Entendido|Recibido|Confirmado).{0,40}(?:proceso|homolog|reescritura)/i,
  // Mechanical hallucination replacement (from our detector)
  /⚠️ No completé la acción solicitada/i,
  /Herramientas que SÍ llamé/i,
  // System errors
  /🔴 ERROR DE SISTEMA/i,
  /el sistema encontr[oó] un error/i,
  /herramientas? no est[aá](?:n)? respondiendo/i,
  // Tool refusals (LLM claims it can't use available tools) — the one family
  // a verified exchange skips (REFUSAL_PATTERNS above, queue 4g).
  ...REFUSAL_PATTERNS,
  // Learned helplessness — LLM gives up or reports inability to continue.
  // Require sentence-start position (^|\n|[.!?]\s+) to avoid matching
  // inside capability reports ("No puedo hacer búsquedas" as status vs refusal).
  /(?:^|[\n.!?]\s*)no puedo (?:continuar|completar|ejecutar)\b/im,
  // Anchored to sentence-start too (2026-06-17 FP fix). An external description
  // ("...el broker ejecutó el stop como buy stop por error de configuración —
  // ya lo corregiste") is a legitimate status report, NOT Jarvis self-excusing.
  // Only a sentence-initial claim is the learned-helplessness signal; the
  // unanchored forms stripped a real vision-analysis answer from the thread,
  // which read as the assistant "forgetting" its own prior reply.
  // ACCEPTED TRADEOFF (qa W1): a genuine self-error phrased mid-clause ("Hubo un
  // error de configuración con Gmail, no pude enviar") is NOT caught here and
  // has NO sibling net — unlike the don't-ask class below. We accept that false
  // negative because over-stripping a real answer is worse than leaving one
  // self-excuse in the buffer; the durable fix for self-excuses is the persona,
  // not this regex.
  /(?:^|[\n.!?]\s*)problema t[eé]cnico (?:cr[ií]tico|grave)/im,
  /(?:^|[\n.!?]\s*)error de configuraci[oó]n/im,
  // Tool configuration errors (stale from prior session)
  /(?:wordpress|wp).{0,20}not configured/i,
  /falla con.*(?:not configured|no configurad)/i,
  // False capability claims — LLM researches tool docs instead of calling tools
  /(?:API|endpoint|modelo).{0,30}no soporta.{0,30}(?:generaci[oó]n|imagen|image)/i,
  /(?:API|endpoint|model).{0,30}(?:doesn.t|does not|cannot).{0,30}(?:generat|image|support.*image)/i,
  /requiere.{0,20}(?:Vertex AI|billing|configuraci[oó]n diferente)/i,
  // Inference cascade failures
  /inference.*failed/i,
  /timeout.*inference/i,
  // Narrated update claim — LLM claims to have updated NorthStar without tools.
  // NOTE: "Acciones Ejecutadas" removed from here — it's a legitimate header
  // when tools actually ran. The hallucination guard (hallucination-guard Layer 2)
  // handles it with tool-call context; the poison filter cannot distinguish.
  /acabo de actualizar\s+NorthStar/i,
  // Confabulated permission-block refusals (2026-06-16). gmail_send and MCP
  // tools (e.g. mcp__supabase__query) are in scope AND auto-approved under the
  // SDK's permissionMode:"dontAsk" — yet the LLM sometimes invents a "blocked
  // by don't-ask policy" gate and refuses instead of calling the available
  // tool. Left in the thread buffer the excuse reinforces (the LLM reads its
  // own prior refusal and repeats it → the "recurring" symptom). Strip it.
  // The real fix is the persona (confirmationSection + "solo usa herramientas
  // disponibles"); this is the belt-and-suspenders so a stray one can't recur.
  // Patterns are anchored on the confabulation's distinguishing signature —
  // the FALSE "blocked by a session/policy/don't-ask permission gate" framing —
  // NOT on a bare "X está bloqueado", which legitimately reports a real external
  // block (rate-limit, Cloudflare, provider lockout) we must NOT strip.
  // The confabulation always frames it as a "don't ask MODE/policy" gate, never
  // a bare phrase. Require the mode/modo signature so an incidental English
  // "don't ask" in legitimate prose ("you said don't ask, so I just did it")
  // can't strip a real answer (2026-06-17 FP fix; the bare /\bdon.?t ask\b/
  // form was over-broad). A real don't-ask refusal also carries a
  // `bloqueado … don't ask` clause (next pattern) or `no tengo acceso` (the
  // latter only when unverified: a verified exchange skips the refusal
  // family, queue 4g), so the don't-ask class stays caught even if this
  // signature drifts. NOTE: that
  // sibling net is specific to the don't-ask class — it does NOT backstop the
  // sentence-anchored self-error patterns above.
  /(?:modo\s*['"]?\s*don.?t[\s-]?ask|don.?t[\s-]?ask[\s'"-]*mode)/i,
  /\bbloquead[oa]s?\b[^.\n]{0,40}(?:en esta sesi[oó]n|por la pol[ií]tica|don.?t[\s-]?ask)/i,
  /requiere\s+(?:permiso|autorizaci[oó]n|confirmaci[oó]n)\s+(?:del|de)\s+sistema/i,
];

/** `verified` (queue 4g) exempts only REFUSAL_PATTERNS; every other family
 *  (system errors, hallucination replacement, learned helplessness, false
 *  capability, don't-ask) still strips a verified reply. */
export function isPoisonedExchange(
  jarvisResponse: string,
  opts: { verified?: boolean } = {},
): boolean {
  return POISONED_RESPONSE_PATTERNS.some(
    (p) =>
      !(opts.verified && REFUSAL_PATTERNS.includes(p)) &&
      p.test(jarvisResponse),
  );
}
