/**
 * Prompt Enhancer — gatekeeper that intercepts user messages,
 * asks clarifying questions, and builds optimized prompts for Jarvis.
 *
 * Flow:
 * 1. User sends message → shouldEnhance() checks if it needs enhancement
 * 2. If yes → analyzePrompt() calls LLM to generate 2-3 questions
 * 3. Questions sent to user via Telegram
 * 4. User answers → buildEnhancedPrompt() creates the optimized prompt
 * 5. Enhanced prompt submitted to Jarvis as the real task
 *
 * Disabled via PROMPT_ENHANCER_ENABLED=false (default: true).
 * User can toggle with "enhancer off" / "enhancer on".
 */

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

interface EnhancerState {
  status: "asking" | "waiting";
  originalMessage: string;
  questions: string;
  timestamp: number;
}

const channelState = new Map<string, EnhancerState>();
const TIMEOUT_MS = 2 * 60_000; // 2 min — if no answer, pass original through
let enabled = (process.env.PROMPT_ENHANCER_ENABLED ?? "true") !== "false";

// ---------------------------------------------------------------------------
// Pass-through detection
// ---------------------------------------------------------------------------

const PASSTHROUGH_PATTERNS = [
  // Greetings
  /^(hola|hey|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|qu[eé]\s*tal|saludos?)\b/i,
  // Short confirmations
  /^(s[ií]|no|ok|dale|va|sale|listo|perfecto|gracias|exacto|genial|procede|adelante|contin[uú]a|confirma(do)?)\b/i,
  // Toggle commands
  /^(enhancer\s*(on|off|estado))\b/i,
  // Emoji responses
  /^👍|^🙏|^💪|^✅/,
  // Read-only action verbs — these never need clarification
  /^(lista|listar|muestra|mostrar|lee|leer|abre|abrir|monitor(ea)?|estado|status|resume|resumen|describe|consulta|dame|dime)\b/i,
  // Continuation / follow-up — user is telling Jarvis to keep going, not starting a new task
  /^(contin[uú]a|sigue|termin[ae]|completa|finaliza|acaba)\b/i,
  // Skip / skip enhancer signals
  /\b(hazlo|procede|skip|sin preguntas|ejecuta|haz(lo)?\s+ya)\b/i,
];

const MIN_ENHANCE_LENGTH = 40; // Messages shorter than this pass through

/**
 * Should this message be enhanced?
 * Short messages, greetings, confirmations, and toggle commands pass through.
 */
export function shouldEnhance(text: string): boolean {
  if (!enabled) return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_ENHANCE_LENGTH) return false;
  if (PASSTHROUGH_PATTERNS.some((p) => p.test(trimmed))) return false;
  return true;
}

/**
 * Check if the user is toggling the enhancer.
 * Returns the new state or null if not a toggle command.
 */
export function checkToggle(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (t === "enhancer off" || t === "sin enhancer") {
    enabled = false;
    return false;
  }
  if (t === "enhancer on" || t === "con enhancer") {
    enabled = true;
    return true;
  }
  if (t === "enhancer estado" || t === "enhancer status") {
    return enabled;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

/** Check if a channel is waiting for enhancement answers. */
export function isWaitingForAnswers(channel: string): boolean {
  const state = channelState.get(channel);
  if (!state) return false;
  // Expire stale states
  if (Date.now() - state.timestamp > TIMEOUT_MS) {
    channelState.delete(channel);
    return false;
  }
  return state.status === "waiting";
}

/** Get the original message for a channel in enhancement flow. */
export function getOriginalMessage(channel: string): string | null {
  return channelState.get(channel)?.originalMessage ?? null;
}

/** Get the questions that were asked for a channel. */
export function getQuestions(channel: string): string {
  return channelState.get(channel)?.questions ?? "";
}

/** Clear enhancement state for a channel. */
export function clearEnhancerState(channel: string): void {
  channelState.delete(channel);
}

/** Set state to waiting for answers. */
export function setWaiting(
  channel: string,
  originalMessage: string,
  questions: string,
): void {
  channelState.set(channel, {
    status: "waiting",
    originalMessage,
    questions,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// LLM analysis — generates questions or PASS
// ---------------------------------------------------------------------------

/**
 * CIRICD-aware gatekeeper prompt (v6.4 PE1).
 *
 * Scores 6 dimensions: Clarity, Intent, Risk, Context, Impact, Decompose.
 * Only asks questions when specific dimensions score low.
 * Output is structured JSON for reliable parsing.
 */
const ENHANCER_SYSTEM_PROMPT = `Eres un optimizador de prompts para Jarvis, un agente autónomo de AI con 170 herramientas.

Analiza el mensaje del usuario EN CONTEXTO de la conversación reciente usando el framework CIRICD:

## SCORING (evalúa cada dimensión)

**C — Clarity** (0-10): ¿Es claro qué quiere el usuario?
  10 = instrucción precisa con paths/destinos explícitos
  5 = intención clara pero faltan detalles menores (Jarvis puede inferir)
  0 = totalmente ambiguo, múltiples interpretaciones posibles

**I — Intent**: Extrae la acción principal en una frase.
  Ej: "Publicar artículo en WordPress", "Enviar reporte por email a Javier"

**R — Risk** (high/low): ¿La ambigüedad puede causar un ERROR GRAVE?
  high = acción destructiva (borrar, sobreescribir), envío a destino incorrecto, datos que se pierden
  low = lectura, búsqueda, análisis, creación de contenido nuevo

**I2 — Impact** (count): ¿Cuántos items afecta?
  Cuenta archivos, registros, emails, tareas. Si no es claro, estima.

**C2 — Context** (resolved/unresolved): ¿La conversación reciente aclara las dudas?
  resolved = paths, repos, destinos ya mencionados en conversación
  unresolved = información crítica faltante que Jarvis NO puede inferir

**D — Decompose** (ok/split): ¿Necesita dividirse?
  split = >5 archivos O >10 tool calls O batch (migrar/mover muchos items)
  ok = cabe en 35 rounds (max ~5 archivos por mensaje)

## DECISIÓN

Basándote en los scores:
- **PASS** si: Clarity ≥ 7 OR (Clarity ≥ 5 AND Risk = low AND Context = resolved AND Decompose = ok)
- **ASSUME** si: Clarity 4-6 AND Risk = low → declara tu interpretación en "assumption". Jarvis procede con esa interpretación. El usuario corrige si se equivoca.
- **ASK** si: Clarity < 4 AND Risk = high AND Context = unresolved → genera EXACTAMENTE 2 preguntas
- **SPLIT** si: Decompose = split → sugiere plan de división en bloques de max 5 items

DEFAULT = PASS. Solo usa ASK cuando la ambigüedad + riesgo harían daño. Prefiere ASSUME sobre ASK — es mejor intentar y que el usuario corrija que preguntar de más.

## FORMATO DE RESPUESTA (JSON estricto)

{"decision":"PASS","intent":"...","clarity":8,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}

{"decision":"ASSUME","intent":"...","clarity":5,"risk":"low","impact":2,"context":"unresolved","decompose":"ok","assumption":"Entiendo que quieres actualizar el status de las tareas de VLMP a completadas"}

{"decision":"ASK","intent":"...","clarity":2,"risk":"high","impact":1,"context":"unresolved","decompose":"ok","questions":["¿A qué archivo te refieres?","¿Quieres sobreescribir o crear uno nuevo?"]}

{"decision":"SPLIT","intent":"...","clarity":7,"risk":"low","impact":23,"context":"resolved","decompose":"split","split_plan":"Sugiero dividir en 3 bloques:\\n1. Los 6 archivos de X\\n2. Los 15 de Y\\n3. Los 2 restantes\\n¿Con cuál empezamos?"}

CONTEXTO DEL SISTEMA:
- Jarvis Knowledge Base: jarvis_file_read/write/list
- Git: git_commit y git_push REQUIEREN cwd=
- LÍMITES: 35 rounds/tarea, 50K tokens. Cada file read+write = 2 rounds. Max ~5 archivos por mensaje.

RESPONDE SOLO con JSON válido. Nada más.`;

/** Parsed CIRICD analysis result. */
export interface CiricdResult {
  decision: "PASS" | "ASSUME" | "ASK" | "SPLIT";
  intent: string;
  clarity: number;
  risk: "high" | "low";
  impact: number;
  context: "resolved" | "unresolved";
  decompose: "ok" | "split";
  questions?: string[];
  splitPlan?: string;
  /** Stated interpretation when decision=ASSUME (v6.4 CL1.3). */
  assumption?: string;
}

/**
 * Parse a CIRICD JSON response from the LLM.
 * Returns null if parsing fails (caller should default to PASS).
 */
export function parseCiricdResponse(raw: string): CiricdResult | null {
  try {
    // Extract JSON from possible markdown code fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.decision) return null;
    return {
      decision: (
        parsed.decision as string
      ).toUpperCase() as CiricdResult["decision"],
      intent: parsed.intent ?? "",
      clarity: typeof parsed.clarity === "number" ? parsed.clarity : 5,
      risk: parsed.risk === "high" ? "high" : "low",
      impact: typeof parsed.impact === "number" ? parsed.impact : 1,
      context: parsed.context === "unresolved" ? "unresolved" : "resolved",
      decompose: parsed.decompose === "split" ? "split" : "ok",
      questions: Array.isArray(parsed.questions)
        ? (parsed.questions as string[]).slice(0, 2)
        : undefined,
      splitPlan: parsed.split_plan as string | undefined,
      assumption: parsed.assumption as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Analyze a user message using CIRICD framework and return questions or "PASS".
 * Uses a cheap, fast LLM call (flash tier).
 */
export async function analyzePrompt(
  userMessage: string,
  recentContext: string,
): Promise<string> {
  try {
    const { infer } = await import("../inference/adapter.js");
    // 10s deadline — if LLM is slow, pass through rather than block
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("enhancer timeout")), 10_000),
    );
    const result = await Promise.race([
      infer({
        messages: [
          { role: "system", content: ENHANCER_SYSTEM_PROMPT },
          {
            role: "user",
            content: recentContext
              ? `Contexto reciente:\n${recentContext}\n\nMensaje del usuario:\n${userMessage}`
              : `Mensaje del usuario:\n${userMessage}`,
          },
        ],
        max_tokens: 250,
      }),
      deadline,
    ]);

    const raw = (result.content ?? "PASS").trim();
    if (raw.toUpperCase() === "PASS") return "PASS";

    // Parse CIRICD JSON response
    const ciricd = parseCiricdResponse(raw);
    if (!ciricd) {
      // Failed to parse — check if it's a legacy-format response
      if (raw.toUpperCase().startsWith("PASS")) return "PASS";
      // Treat as raw questions (backward compat)
      const questionLines = raw
        .split("\n")
        .filter((l) => /^\s*(\d+[\.\)]|[-•*])\s/.test(l));
      if (questionLines.length > 2) {
        return questionLines.slice(0, 2).join("\n");
      }
      return raw;
    }

    // Log CIRICD scores for observability
    console.log(
      `[enhancer] CIRICD: decision=${ciricd.decision} clarity=${ciricd.clarity} risk=${ciricd.risk} impact=${ciricd.impact} context=${ciricd.context} decompose=${ciricd.decompose} intent="${ciricd.intent}"`,
    );

    if (ciricd.decision === "PASS") return "PASS";

    // v6.4 CL1.3: Assumption-first — proceed with stated interpretation.
    // Returns "PASS" to the router (don't block), but logs the assumption.
    // The LLM receives the assumption as precedent context, not as a rewrite.
    if (ciricd.decision === "ASSUME") {
      if (ciricd.assumption) {
        console.log(
          `[enhancer] ASSUME: "${ciricd.assumption}" (clarity=${ciricd.clarity})`,
        );
      }
      return "PASS"; // Don't block — let the LLM proceed with its interpretation
    }

    if (ciricd.decision === "SPLIT" && ciricd.splitPlan) {
      return ciricd.splitPlan;
    }

    if (ciricd.decision === "ASK" && ciricd.questions?.length) {
      return ciricd.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    }

    return "PASS"; // Fallback
  } catch {
    return "PASS";
  }
}

// ---------------------------------------------------------------------------
// Enhanced prompt builder
// ---------------------------------------------------------------------------

const BUILDER_SYSTEM_PROMPT = `Eres un constructor de prompts optimizados para Jarvis, un agente autónomo de AI.

Recibes:
1. El mensaje original del usuario
2. Las preguntas que se hicieron
3. Las respuestas del usuario (pueden ser respuestas numeradas O texto libre con aclaraciones)

Tu trabajo: construir UN prompt claro y estructurado que Jarvis pueda ejecutar sin ambigüedad.
Las respuestas del usuario pueden ser texto libre — no necesariamente respuestas punto por punto.
Extrae la intención y los datos de lo que el usuario escribió, sin importar el formato.

REGLAS DE CONSTRUCCIÓN:
- Incluye rutas de archivos completas (/root/claude/...)
- Incluye cwd= para operaciones git
- Si involucra datos externos: agrega "Cero datos hardcodeados. Usa EXCLUSIVAMENTE los datos de la fuente."
- Termina con un paso de verificación ("Muéstrame..." o "Verifica con...")
- LÍMITE CRÍTICO: el prompt debe involucrar MÁXIMO 5 archivos o 10 tool calls. Si la tarea es más grande, construye SOLO el primer bloque y agrega al final: "Cuando termines, avísame para continuar con el siguiente bloque."
- Para operaciones con jarvis_file_*: usa jarvis_file_write (NO file_write) para la Knowledge Base
- Si es un task complejo (>15 pasos): divídelo con "PASO 1:" y "PASO 2: (siguiente mensaje)"
- Escribe el prompt en el mismo idioma que el usuario (español por defecto)
- NO agregues explicaciones — solo el prompt optimizado

RESPONDE SOLO con el prompt optimizado, sin preámbulos ni explicaciones.`;

/**
 * Build an enhanced prompt from the original message + user's answers.
 */
export async function buildEnhancedPrompt(
  originalMessage: string,
  questions: string,
  answers: string,
  recentContext?: string,
): Promise<string> {
  try {
    const { infer } = await import("../inference/adapter.js");
    const builderDeadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("builder timeout")), 15_000),
    );

    const contextBlock = recentContext
      ? `CONVERSACIÓN RECIENTE (últimos 2 turnos):\n${recentContext}\n\n`
      : "";

    const result = await Promise.race([
      infer({
        messages: [
          { role: "system", content: BUILDER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${contextBlock}MENSAJE ORIGINAL:\n${originalMessage}\n\nPREGUNTAS QUE SE HICIERON:\n${questions}\n\nRESPUESTAS/ACLARACIONES DEL USUARIO:\n${answers}`,
          },
        ],
        max_tokens: 500,
      }),
      builderDeadline,
    ]);

    return (result.content ?? "").trim() || originalMessage;
  } catch {
    return originalMessage;
  }
}

/** Check if the enhancer is currently enabled. */
export function isEnabled(): boolean {
  return enabled;
}
