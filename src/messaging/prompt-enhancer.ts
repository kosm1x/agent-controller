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
const TIMEOUT_MS = 5 * 60_000; // 5 min — if no answer, pass original through
let enabled = (process.env.PROMPT_ENHANCER_ENABLED ?? "true") !== "false";

// ---------------------------------------------------------------------------
// Pass-through detection
// ---------------------------------------------------------------------------

const PASSTHROUGH_PATTERNS = [
  /^(hola|hey|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|qu[eé]\s*tal|saludos?)\b/i,
  /^(s[ií]|no|ok|dale|va|sale|listo|perfecto|gracias|exacto|genial|procede|adelante|continua|confirma(do)?)\b/i,
  /^(enhancer\s*(on|off|estado))\b/i,
  /^👍|^🙏|^💪|^✅/,
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

const ENHANCER_SYSTEM_PROMPT = `Eres un optimizador de prompts para Jarvis, un agente autónomo de AI con 144 herramientas.

Tu trabajo: analizar el mensaje del usuario y decidir si necesita clarificación antes de enviarlo a Jarvis.

REGLAS:
1. Si el mensaje es claro y específico (tiene paths, IDs, acciones concretas) → responde EXACTAMENTE "PASS"
2. Si el mensaje tiene ambigüedades que causarán problemas → genera 2-3 preguntas cortas en español
3. NUNCA hagas más de 3 preguntas
4. Las preguntas deben ser sobre: rutas de archivos, repos destino, fuentes de datos, formato de output
5. NO preguntes sobre cosas que Jarvis puede inferir (lenguaje obvio, herramientas a usar)

CONTEXTO DEL SISTEMA:
- Proyecto principal: /root/claude/mission-control/ → kosm1x/agent-controller
- Proyecto CuatroFlor: /root/claude/cuatro-flor/ → EurekaMD-net/cuatro-flor
- NorthStar: visiones/metas/objetivos/tareas en archivos markdown
- Intel Depot: 8 fuentes de señales (mercados, clima, geopolítica, cyber)
- Git: Jarvis tiene git_commit y git_push que REQUIEREN cwd= (directorio del proyecto)
- Google Sheets: Jarvis puede leer con gsheets_read pero NO puede hacer fetch desde HTML en browser (CORS)

RESPONDE SOLO con:
- "PASS" si no necesita preguntas
- O las preguntas numeradas (1. 2. 3.) sin explicación adicional`;

/**
 * Analyze a user message and return questions or "PASS".
 * Uses a cheap, fast LLM call (flash tier).
 */
export async function analyzePrompt(
  userMessage: string,
  recentContext: string,
): Promise<string> {
  try {
    const { infer } = await import("../inference/adapter.js");
    const result = await infer({
      messages: [
        { role: "system", content: ENHANCER_SYSTEM_PROMPT },
        {
          role: "user",
          content: recentContext
            ? `Contexto reciente:\n${recentContext}\n\nMensaje del usuario:\n${userMessage}`
            : `Mensaje del usuario:\n${userMessage}`,
        },
      ],
      max_tokens: 200,
    });

    return (result.content ?? "PASS").trim();
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
3. Las respuestas del usuario

Tu trabajo: construir UN prompt claro y estructurado que Jarvis pueda ejecutar sin ambigüedad.

REGLAS DE CONSTRUCCIÓN:
- Incluye rutas de archivos completas (/root/claude/...)
- Incluye cwd= para operaciones git
- Si involucra datos externos: agrega "Cero datos hardcodeados. Usa EXCLUSIVAMENTE los datos de la fuente."
- Termina con un paso de verificación ("Muéstrame..." o "Verifica con...")
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
): Promise<string> {
  try {
    const { infer } = await import("../inference/adapter.js");
    const result = await infer({
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `MENSAJE ORIGINAL:\n${originalMessage}\n\nPREGUNTAS QUE SE HICIERON:\n${questions}\n\nRESPUESTAS DEL USUARIO:\n${answers}`,
        },
      ],
      max_tokens: 500,
    });

    return (result.content ?? "").trim() || originalMessage;
  } catch {
    return originalMessage;
  }
}

/** Check if the enhancer is currently enabled. */
export function isEnabled(): boolean {
  return enabled;
}
