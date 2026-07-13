/**
 * V8 substrate S2 — community-manager email reply write-gate (v7.7 Spine 1 Phase 2b).
 *
 * The community-manager email path (e.g. `comunidades@mexiconecesario.org.mx`)
 * sends LLM-composed replies to external members of the public. Unlike the
 * morning_brief retrofit (Phase 2a, where the audit is OBSERVABILITY and the
 * brief ships regardless of verdict), here the critic IS a TRUE WRITE-GATE:
 *
 *   reply text → critic (this module) → pass: adapter.send original
 *                                     → fail: adapter.send fallback acknowledgement
 *
 * Why a free-text critic instead of the typed-evidence contract used by
 * morning_brief: the LLM in community-manager mode has only 5 read-only tools
 * (no submit_report; persona-restricted to deferral/acknowledgement). The
 * reply is conversational free text, not a typed report. A router-level
 * post-hoc verifier matches the actual flow (LLM produces text, router sends)
 * better than retrofitting a typed contract the LLM couldn't reasonably emit.
 *
 * Fail-safe: critic infrastructure error → treat as fail → fallback used. We
 * never ship un-audited text from a community-manager mailbox.
 */

import { infer } from "../inference/adapter.js";
import { errMsg } from "../lib/err-msg.js";

/**
 * Generic Spanish acknowledgement shipped in place of any reply that fails
 * the audit. Deliberately:
 *   - Acknowledges receipt (member doesn't feel ignored)
 *   - Defers all substance to the team (no factual claim leaks)
 *   - Free of organizational metrics, dates, names, commitments
 *   - Free of "I am an AI" framing (per persona rules)
 *
 * Sender's name is intentionally NOT interpolated — the gate doesn't have
 * stable access to the sender's parsed name and any wrong inference defeats
 * the safety property. A bare neutral greeting is better than a wrong one.
 */
export const COMMUNITY_REPLY_FALLBACK = `Hola,

Gracias por escribirnos. Hemos recibido tu mensaje y un miembro del equipo te responderá pronto con la información que necesitas.

Saludos cordiales,
El equipo`;

export const COMMUNITY_REPLY_CRITIC_PROMPT = `Eres el auditor de mensajes salientes del buzón de community manager de una organización. El destinatario es un miembro del público (donador, miembro de la comunidad, proveedor, ciudadano interesado, etc.). El mensaje se enviará por correo electrónico desde una cuenta institucional.

Tu único trabajo: detectar afirmaciones factuales específicas sobre la organización que NO sean acuses genéricos o deferrals al equipo humano.

PASS (apruébalas — son seguras):
- Saludos y acuses de recibo ("Hola, gracias por escribirnos", "Recibimos tu mensaje")
- Deferrals al equipo ("Un miembro del equipo te contactará pronto", "Te daremos seguimiento", "El equipo se encargará")
- Descripciones genéricas del rol/persona presentes en el prompt del sistema
- Redirecciones a recursos públicos genéricos (un sitio web, un teléfono general)
- Disculpas y agradecimientos sin compromisos específicos
- Mensajes del sistema (reinicios, notificaciones de servicio, errores) — pasan tal cual
- Texto vacío o muy corto

FAIL (recházalas — son afirmaciones específicas sin cita verificable):
- Métricas: "Tenemos X miembros", "Recaudamos $Y", "Servimos a Z comunidades"
- Fechas específicas: "El próximo evento es el 15 de junio", "El programa cerró en marzo"
- Compromisos con plazos: "Te respondemos antes del viernes", "Enviaremos la información en 24 horas"
- Decisiones nombradas: "Aprobamos tu solicitud", "Confirmamos el donativo"
- Nombres de programas/eventos específicos como si fueran hechos comprobados que el destinatario no proporcionó
- Cantidades, montos, porcentajes, nombres propios de programas/eventos no presentes en el contexto del prompt

Si dudas, INCLÍNATE A PASAR. El criterio es "¿contiene una afirmación factual específica que la organización tendría que verificar antes de externalizar?" — si la respuesta es ambigua, asume que no.

Devuelve EXCLUSIVAMENTE JSON con esta forma:
{"verdict": "pass" | "fail", "critique": "<una frase si fail; vacío si pass>"}

No expliques. No reformules el mensaje. No propongas correcciones. Tu salida es solo el veredicto.`;

export interface GateOptions {
  /** Override provider/model. Default: same as caller (cache-friendly). */
  providerName?: string;
  /** Hard cap on critic latency. Default 15s — email is async but the gate
   *  blocks the send, so keep this tight. */
  timeoutMs?: number;
  /** Caller's abort signal. */
  signal?: AbortSignal;
}

export interface GateResult {
  verdict: "pass" | "fail";
  critique: string;
  /** USD cost of the critic call when the provider reports it. */
  costUsd?: number;
  /** Wall-clock latency of the critic call in ms. */
  latencyMs: number;
  /**
   * True when the critic call failed at the infrastructure layer (timeout,
   * API error, malformed JSON). Caller MUST treat error=true as a fail and
   * use the fallback — never ship un-audited text from a community channel.
   */
  error: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Run the community-reply critic against a proposed outbound text. See module
 * docstring for fail-mode semantics.
 *
 * Returns synchronously-resolvable promise — caller should `await` before
 * calling `adapter.send` so the gate verdict can replace text with fallback.
 */
export async function gateCommunityReply(
  text: string,
  options: GateOptions = {},
): Promise<GateResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  // Pre-check: caller signal already aborted → fail-safe immediately so the
  // sender doesn't ship un-audited text against an exhausted budget.
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    const msg =
      reason instanceof Error ? reason.message : String(reason ?? "aborted");
    return {
      verdict: "fail",
      critique: `gate skipped: caller signal already aborted (${msg})`,
      latencyMs: 0,
      error: true,
    };
  }

  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("community-reply gate timeout")),
    timeoutMs,
  );
  // Idempotent abort: if the caller signal aborts AFTER infer() already
  // resolved but BEFORE finally runs, ac.abort() is a no-op on an
  // already-settled request. Still cheap; guard avoids the noise of
  // double-abort dispatches in shared infrastructure (R1-W5).
  const onAbort = () => {
    if (!ac.signal.aborted) ac.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await infer(
      {
        messages: [
          { role: "system", content: COMMUNITY_REPLY_CRITIC_PROMPT },
          { role: "user", content: `Mensaje saliente a auditar:\n\n${text}` },
        ],
        temperature: 0,
        max_tokens: 256,
        costLedger: { agentType: "aux:community-reply-gate" },
      },
      { providerName: options.providerName, signal: ac.signal },
    );

    const latencyMs = Date.now() - t0;
    const raw = response.content?.trim() ?? "";

    if (!raw) {
      return {
        verdict: "fail",
        critique: "critic returned empty response",
        latencyMs,
        costUsd: response.usage?.cost_usd,
        error: true,
      };
    }

    const parsed = parseVerdict(raw);
    if (!parsed) {
      return {
        verdict: "fail",
        critique: `critic returned non-JSON response: ${raw.slice(0, 200)}`,
        latencyMs,
        costUsd: response.usage?.cost_usd,
        error: true,
      };
    }

    return {
      verdict: parsed.verdict,
      critique: parsed.critique,
      latencyMs,
      costUsd: response.usage?.cost_usd,
      error: false,
    };
  } catch (e) {
    return {
      verdict: "fail",
      critique: `critic call failed: ${errMsg(e)}`,
      latencyMs: Date.now() - t0,
      error: true,
    };
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Tolerant JSON parser shared with audit/critic.ts in shape. Accepts pure
 * JSON, JSON inside a markdown fence, or JSON inside prose. Walks balanced
 * `{...}` candidates and returns the first that parses to the verdict shape.
 */
function parseVerdict(
  raw: string,
): { verdict: "pass" | "fail"; critique: string } | null {
  let candidate = raw;

  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) candidate = fenceMatch[1];

  for (const balanced of extractBalancedObjects(candidate)) {
    let obj: unknown;
    try {
      obj = JSON.parse(balanced);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const v = (obj as Record<string, unknown>).verdict;
    const c = (obj as Record<string, unknown>).critique;
    if (v !== "pass" && v !== "fail") continue;
    if (typeof c !== "string") continue;
    return { verdict: v, critique: c };
  }
  return null;
}

function* extractBalancedObjects(s: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        yield s.slice(start, i + 1);
        start = -1;
      }
    }
  }
}
