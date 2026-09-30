/**
 * Jarvis Pull endpoint — allows external systems (CRM agents) to request
 * Jarvis's analytical capabilities with role-based depth control.
 *
 * POST /api/jarvis-pull
 * Body: { query: string, role: "ae"|"gerente"|"director"|"vp", context?: string }
 * Returns: { response: string, role, model: "jarvis", tokens: number }
 *
 * The request runs as a Jarvis chat turn through the task seam (fast runner,
 * `external` flag): opt-in KB rows only (tagged `external` or under the seed
 * prefixes; enforce = repo-authorization only — src/lib/external-kb-policy.ts),
 * a read-only research toolset with the file tools scoped by the same policy, NO operator-private memory, a
 * capped number of tool rounds. Past the deadline, on failure, or with
 * JARVIS_PULL_MAX_INFLIGHT tasks already running, the route answers with a
 * single tool-less call, labelled as such in the Fuentes line. The whole
 * request is bounded by JARVIS_PULL_BUDGET_MS.
 *
 * v5.0 S4 completion: reverse A2A channel (CRM → Jarvis).
 */

import { createHash } from "crypto";
import { Hono } from "hono";
import { infer } from "../../inference/adapter.js";
import { getFilesByQualifier } from "../../db/jarvis-fs.js";
import { isExternalKbInjectable } from "../../lib/external-kb-policy.js";
import { getDatabase } from "../../db/index.js";
import {
  submitTask,
  cancelTask,
  getRunToolCalls,
  type TaskSubmission,
} from "../../dispatch/dispatcher.js";
import { getEventBus } from "../../lib/event-bus.js";
import type { Event } from "../../lib/events/types.js";
import { extractDeliverableText } from "../../lib/deliverable.js";
import { toolRegistry } from "../../tools/registry.js";
import {
  buildExternalJarvisSystemPrompt,
  CACHE_BREAK_MARKER,
} from "../../messaging/router.js";
import { timeContextLine } from "../../messaging/prompt-sections.js";
import { sanitizeDeliverable } from "../../messaging/deliverable-filter.js";
import { nowMexDate, nowMexTime } from "../../lib/timezone.js";
import {
  JARVIS_PULL_BUDGET_MS,
  JARVIS_PULL_DEADLINE_MS,
  JARVIS_PULL_MAX_INFLIGHT,
} from "../../config/constants.js";
import { errMsg } from "../../lib/err-msg.js";
import { apiRateLimit } from "../rate-limit.js";

const jarvisPull = new Hono();

type CrmRole = "ae" | "gerente" | "director" | "vp";

const ROLE_INSTRUCTIONS: Record<CrmRole, string> = {
  ae: "Responde en máximo 3 bullets concisos. Solo información directamente accionable para un ejecutivo de ventas. Sin análisis extenso — solo qué hacer y por qué.",
  gerente:
    "Incluye métricas clave relevantes y una recomendación concreta. Máximo 5 bullets. Enfoque en lo que el gerente necesita decidir hoy.",
  director:
    "Análisis completo con contexto de mercado, tendencias relevantes y recomendaciones estratégicas. Incluye datos de soporte cuando estén disponibles.",
  vp: "Análisis ejecutivo completo sin restricciones de formato. Incluye visión estratégica, riesgos, oportunidades y recomendaciones priorizadas.",
};

const ROLE_MAX_TOKENS: Record<CrmRole, number> = {
  ae: 300,
  gerente: 500,
  director: 1000,
  vp: 2000,
};

/**
 * Research toolset for an external caller. Resolved per request against the
 * registry: only names that exist AND carry `readOnlyHint: true` are offered.
 * The structural gate is the external tool guard the fast runner installs for
 * an `external` run (executor wrapper on the OpenAI path, execution context on
 * the SDK path — src/tools/external-tool-guard.ts): a tool outside the run's
 * list never executes, and jarvis_file_* stay inside the external KB policy.
 * `http_fetch` is deliberately absent (readOnlyHint false: it can POST);
 * `memory_search` and `task_history` too — read-only, but they expose
 * operator-private data (jarvis memory bank, operator task history).
 */
export const JARVIS_PULL_TOOLS = [
  "web_search",
  "web_read",
  "intel_query",
  "intel_status",
  "intel_alert_history",
  "intel_baseline",
  "jarvis_file_search",
  "jarvis_file_read",
  "jarvis_file_list",
];

/** Tool-round cap for the research task (the runner may add one resume leg). */
export const JARVIS_PULL_MAX_ROUNDS = 8;

const FUENTES_RE = /^.*📎\s*Fuentes\s*:.*$/gm;
const FUENTES_OWN = "📎 Fuentes: Análisis propio";
const FALLBACK_FUENTES = {
  deadline:
    "📎 Fuentes: Análisis propio (sin herramientas: se agotó el tiempo de investigación)",
  error:
    "📎 Fuentes: Análisis propio (sin herramientas: falló la investigación)",
  busy: "📎 Fuentes: Análisis propio (sin herramientas: Jarvis atiende otras consultas)",
} as const;
const OUT_OF_TIME = "Jarvis no alcanzó a responder a tiempo.";
const OUT_OF_TIME_FUENTES = "📎 Fuentes: ninguna (sin respuesta a tiempo)";

/** The near-empty retry is skipped when less than this remains of the budget. */
const RETRY_MIN_REMAINING_MS = 15_000;

/** Research tasks this route is waiting on right now (W5 cap). */
let inflight = 0;

let loggedDropped = "";

function resolvePullTools(): string[] {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of JARVIS_PULL_TOOLS) {
    if (toolRegistry.get(name)?.readOnlyHint === true) kept.push(name);
    else dropped.push(name);
  }
  const key = dropped.join(",");
  if (key && key !== loggedDropped) {
    loggedDropped = key;
    console.warn(
      `[jarvis-pull] dropped tools (unregistered or not read-only): ${key}`,
    );
  }
  return kept;
}

function pullAddendum(role: CrmRole, deadlineMs: number): string {
  const words = Math.round(ROLE_MAX_TOKENS[role] * 0.75);
  return (
    "## Consulta externa (CRM)\n" +
    "Un agente del CRM (Pulso) te consulta; el operador no está en esta conversación. " +
    "No hagas preguntas ni pidas confirmaciones: responde con lo que puedas investigar.\n\n" +
    `Tienes un límite de ~${Math.round(deadlineMs / 1000)} s y un máximo de ${JARVIS_PULL_MAX_ROUNDS} rondas de herramientas. ` +
    "Investiga primero (KB con jarvis_file_*, señales con intel_*, web con web_*) y después responde en un solo mensaje final.\n\n" +
    'Los archivos de la KB compartidos con el CRM se encuentran con jarvis_file_read({tags:["external"]}) y bajo los prefijos semilla (p. ej. knowledge/domain/tv-, knowledge/domain/media-market-); ' +
    "los resultados de jarvis_file_search y jarvis_file_list ya vienen filtrados a lo que puedes ver, y una respuesta \"path not available\" es definitiva: no reintentes con otra escritura de la ruta.\n" +
    "En esta consulta no tienes acceso al DENUE Analyzer: nunca cites cifras del DENUE de memoria; usa solo las que leas en la KB en esta respuesta.\n\n" +
    `INSTRUCCIONES DE FORMATO (rol: ${role}):\n${ROLE_INSTRUCTIONS[role]}\n` +
    `Extensión aproximada: no más de ~${words} palabras.\n\n` +
    "OBLIGATORIO: Termina SIEMPRE con una línea '📎 Fuentes: …' que liste SOLO lo que consultaste de verdad en esta respuesta: " +
    "los paths de la KB que leíste con jarvis_file_*, los nombres de señales/fuentes que devolvió intel_* (GDELT, CoinGecko, etc.) " +
    "y las URLs que obtuviste con web_*. Escribe 'Análisis propio' solo si ninguna herramienta devolvió algo útil. " +
    "Nunca cites una fuente que no consultaste. " +
    "Esta línea es lo primero que el agente CRM ve — sin ella, el agente no puede citar la fuente."
  );
}

/**
 * Today's single-call path: enforce KB (small cap) + role instructions, no
 * tools. Bounded by `deadlineAt` (epoch ms): null when the budget ran out
 * before an answer (the pending call is aborted).
 */
async function bareAnswer(
  role: CrmRole,
  userMessage: string,
  deadlineAt: number,
): Promise<{ content: string; tokens: number } | null> {
  let systemPrompt =
    "Eres Jarvis, asistente estratégico de inteligencia. Un agente del CRM te está solicitando análisis.\n\n";
  systemPrompt += `INSTRUCCIONES DE FORMATO (rol: ${role}):\n${ROLE_INSTRUCTIONS[role]}\n\n`;
  systemPrompt +=
    "OBLIGATORIO: Termina SIEMPRE con una línea '📎 Fuentes: [lista las fuentes usadas]'. " +
    "Si usaste Intel Depot señales, di qué fuentes (GDELT, CoinGecko, etc.). " +
    "Si usaste KB files, di los paths. Si es conocimiento general, di 'Análisis propio'. " +
    "Esta línea es lo primero que el agente CRM ve — sin ella, el agente no puede citar la fuente.\n\n";

  // Minimal KB context on this tool-less path — the enforce files the external
  // policy allows, capped at 1500 chars.
  try {
    const files = getFilesByQualifier("enforce").filter(isExternalKbInjectable);
    let kbChars = 0;
    for (const f of files) {
      if (kbChars + f.content.length > 1500) break;
      systemPrompt += `---\n${f.content}\n`;
      kbChars += f.content.length;
    }
  } catch {
    // KB not available — proceed without it
  }

  const call = async (temperature: number) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return null;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve(null);
      }, remaining);
    });
    try {
      return await Promise.race([
        infer(
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            max_tokens: ROLE_MAX_TOKENS[role],
            temperature,
          },
          { signal: ac.signal },
        ),
        outOfTime,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Retry once if the model returns a near-empty response (<20 chars).
  // Some providers (kimi) occasionally return 2-4 tokens on valid queries.
  let result = await call(0.3);
  if (!result) return null;

  if (
    (result.content ?? "").length < 20 &&
    deadlineAt - Date.now() >= RETRY_MIN_REMAINING_MS
  ) {
    console.log(
      `[jarvis-pull] Near-empty response (${(result.content ?? "").length} chars), retrying`,
    );
    result = (await call(0.5)) ?? result;
  }

  return {
    content: result.content ?? "",
    tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
  };
}

type TaskOutcome =
  | { kind: "completed"; result: unknown }
  | { kind: "failed"; result: unknown }
  | { kind: "cancelled" }
  | { kind: "deadline" };

/**
 * Submit the task and wait for its terminal event or the deadline. The
 * listeners are attached BEFORE submitTask so a fast completion cannot be
 * missed; events that arrive before the task id is known are buffered.
 */
async function runPullTask(
  submission: TaskSubmission,
  deadlineMs: number,
  onTaskId: (id: string) => void,
): Promise<TaskOutcome> {
  const bus = getEventBus();
  let taskId: string | null = null;
  const early = new Map<string, TaskOutcome>();
  let settle: (o: TaskOutcome) => void = () => {};
  const done = new Promise<TaskOutcome>((resolve) => {
    settle = resolve;
  });
  const on = (id: string, outcome: TaskOutcome): void => {
    if (taskId === null) early.set(id, outcome);
    else if (id === taskId) settle(outcome);
  };
  const subs = [
    bus.subscribe("task.completed", (e: Event<"task.completed">) =>
      on(e.data.task_id, { kind: "completed", result: e.data.result }),
    ),
    bus.subscribe("task.failed", (e: Event<"task.failed">) =>
      on(e.data.task_id, { kind: "failed", result: e.data.result }),
    ),
    bus.subscribe("task.cancelled", (e: Event<"task.cancelled">) =>
      on(e.data.task_id, { kind: "cancelled" }),
    ),
  ];
  const timer = setTimeout(() => settle({ kind: "deadline" }), deadlineMs);
  try {
    const submitted = await submitTask(submission);
    taskId = submitted.taskId;
    onTaskId(taskId);
    const buffered = early.get(taskId);
    early.clear();
    if (buffered) return buffered;
    return await done;
  } finally {
    clearTimeout(timer);
    for (const s of subs) s.unsubscribe();
  }
}

function ledgerFor(taskId: string): { tokens: number; costUsd: number } {
  try {
    const row = getDatabase()
      .prepare(
        "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM cost_ledger WHERE task_id = ?",
      )
      .get(taskId) as { tokens: number; cost: number } | undefined;
    return { tokens: row?.tokens ?? 0, costUsd: row?.cost ?? 0 };
  } catch {
    return { tokens: 0, costUsd: 0 };
  }
}

/** The runner's deliverable, cleaned for an external reader; "" when unusable. */
function deliverableOf(result: unknown): string {
  const raw = extractDeliverableText(result);
  if (!raw) return "";
  const s = sanitizeDeliverable(raw);
  // A failure line is addressed to the operator ("¿Reintento?") — the CRM
  // agent cannot answer it. Keep only the content before it.
  const text = s.failureLine
    ? s.text.slice(0, s.text.lastIndexOf(s.failureLine))
    : s.text;
  // Same for a trailing "¿Sigo?" (the runner skips it for external runs;
  // this is the belt).
  return text.trim().replace(/\n*¿Sigo\?$/, "").trim();
}

// Denial-of-wallet ceiling: this route triggers an LLM task per request and
// the budget gate is observability-only (SEC-09). The /api-wide 300/min is
// sized for dashboard polling, not for inference.
jarvisPull.post(
  "/jarvis-pull",
  // 30/min: the agentic-crm host process, the dashboard and scripts all
  // share the loopback bucket (qa W9).
  apiRateLimit({ windowMs: 60_000, maxPerWindow: 30 }),
  async (c) => {
  let body: { query: string; role?: CrmRole; context?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.query) {
    return c.json({ error: "Missing required field: query" }, 400);
  }

  const role: CrmRole = body.role ?? "ae";
  if (!ROLE_INSTRUCTIONS[role]) {
    return c.json(
      { error: `Invalid role: ${role}. Valid: ae, gerente, director, vp` },
      400,
    );
  }

  const started = Date.now();
  const budgetAt = started + JARVIS_PULL_BUDGET_MS;
  const qHash = createHash("sha256")
    .update(String(body.query))
    .digest("hex")
    .slice(0, 12);

  const userMessage = body.context
    ? `Contexto del CRM: ${body.context}\n\nConsulta: ${body.query}`
    : body.query;

  let taskId: string | null = null;
  let mode:
    | "tools"
    | "fallback-deadline"
    | "fallback-error"
    | "fallback-busy"
    | "budget-exhausted" = "fallback-error";
  let text = "";
  let partial = "";
  let tokens = 0;

  if (inflight >= JARVIS_PULL_MAX_INFLIGHT) {
    mode = "fallback-busy";
  } else {
    inflight++;
    const abortController = new AbortController();
    try {
      const tools = resolvePullTools();
      // An empty `tools` list means "every registered tool" to the runner —
      // never submit one; answer on the tool-less path instead.
      if (tools.length > 0) {
        const { stable, variable } = buildExternalJarvisSystemPrompt(tools);
        const description =
          stable +
          CACHE_BREAK_MARKER +
          variable +
          "\n\n" +
          pullAddendum(role, JARVIS_PULL_DEADLINE_MS);
        const userTurn = `${timeContextLine(nowMexDate(), nowMexTime())}\n\n${userMessage}`;
        const outcome = await runPullTask(
          {
            title: `CRM jarvis-pull: ${String(body.query).slice(0, 50)}`,
            description,
            detectionText: String(body.query),
            agentType: "fast",
            tools,
            tags: ["jarvis-pull", "crm"],
            conversationHistory: [{ role: "user", content: userTurn }],
            abortController,
            external: { maxRounds: JARVIS_PULL_MAX_ROUNDS },
          },
          JARVIS_PULL_DEADLINE_MS,
          (id) => {
            taskId = id;
          },
        );
        if (outcome.kind === "deadline") {
          abortController.abort();
          if (taskId) cancelTask(taskId);
          mode = "fallback-deadline";
        } else if (outcome.kind === "completed") {
          text = deliverableOf(outcome.result);
          if (text) mode = "tools";
        } else if (outcome.kind === "failed") {
          partial = deliverableOf(outcome.result);
        }
      }
    } catch (err) {
      console.warn(`[jarvis-pull] task path failed: ${errMsg(err)}`);
    } finally {
      inflight--;
    }
  }

  let costUsd = 0;
  let toolCount = 0;
  if (taskId) {
    const ledger = ledgerFor(taskId);
    costUsd = ledger.costUsd;
    tokens = ledger.tokens;
    try {
      toolCount = getRunToolCalls(taskId).length;
    } catch {
      toolCount = 0;
    }
  }
  // The task was cancelled mid-run: the ledger holds only what it had written.
  const costPartial = mode === "fallback-deadline";

  const logRequest = (): void => {
    const shortId = taskId ? (taskId as string).slice(0, 8) : "-";
    console.log(
      `[jarvis-pull] role=${role} q=${qHash} task=${shortId} mode=${mode} ms=${Date.now() - started} tools=${toolCount} cost=$${costUsd.toFixed(4)}${costPartial ? "(partial)" : ""} tokens=${tokens}`,
    );
  };

  if (mode === "tools") {
    FUENTES_RE.lastIndex = 0;
    if (!FUENTES_RE.test(text)) text = `${text}\n\n${FUENTES_OWN}`;
  } else {
    let bare: { content: string; tokens: number } | null;
    try {
      bare = await bareAnswer(role, userMessage, budgetAt);
    } catch (err) {
      if (!partial) {
        logRequest();
        const message = errMsg(err);
        return c.json({ error: `Jarvis inference failed: ${message}` }, 503);
      }
      console.warn(`[jarvis-pull] fallback call failed: ${errMsg(err)}`);
      bare = null;
    }
    if (bare) {
      tokens = bare.tokens;
      const reason =
        mode === "fallback-deadline"
          ? "deadline"
          : mode === "fallback-busy"
            ? "busy"
            : "error";
      // No tool ran on this path: any sources the model named are its own.
      const answer = bare.content.replace(FUENTES_RE, "").trim();
      text = `${answer}\n\n${FALLBACK_FUENTES[reason]}`;
    } else {
      // Budget spent (or the fallback failed after a partial answer): the
      // best text available, never a hang.
      mode = "budget-exhausted";
      FUENTES_RE.lastIndex = 0;
      text = partial
        ? FUENTES_RE.test(partial)
          ? partial
          : `${partial}\n\n${FUENTES_OWN}`
        : `${OUT_OF_TIME}\n\n${OUT_OF_TIME_FUENTES}`;
    }
  }

  logRequest();

  return c.json({
    response: text,
    role,
    model: "jarvis",
    tokens,
  });
});

export { jarvisPull };
