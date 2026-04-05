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
  /^(s[ií]|no|ok|dale|va|sale|listo|perfecto|gracias|exacto|genial|procede|adelante|continua|confirma(do)?)\b/i,
  // Toggle commands
  /^(enhancer\s*(on|off|estado))\b/i,
  // Emoji responses
  /^👍|^🙏|^💪|^✅/,
  // Clear action verbs — these are unambiguous commands, don't question them
  /^(lista|listar|muestra|mostrar|busca|buscar|lee|leer|abre|abrir|monitor(ea)?|sincroniza|sync|estado|status|resume|resumen|describe|consulta|dame|dime)\b/i,
  // Skip / skip enhancer signals
  /\b(hazlo|procede|skip|sin preguntas|ejecuta|haz(lo)?\s+ya)\b/i,
];

const MIN_ENHANCE_LENGTH = 80; // Messages shorter than this pass through

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

const ENHANCER_SYSTEM_PROMPT = `Eres un optimizador de prompts para Jarvis, un agente autónomo de AI con 150 herramientas.

Tu trabajo: analizar el mensaje del usuario EN CONTEXTO de la conversación reciente y decidir si necesita clarificación O si necesita ser dividido en partes más pequeñas.

REGLAS:
1. Tu DEFAULT es "PASS". Solo preguntas cuando la ambigüedad causará un ERROR GRAVE (archivo equivocado borrado, datos enviados a destino incorrecto)
2. Si la conversación reciente aclara paths, repos, o datos → "PASS"
3. Si el mensaje es claro y específico → "PASS"
4. Si Jarvis PUEDE inferir la respuesta de su contexto → "PASS"
5. Si hay ambigüedad grave → genera EXACTAMENTE 2 preguntas (nunca 1, nunca 3+)
6. Las preguntas SOLO sobre: destino incorrecto posible, datos que se perderían, acción destructiva ambigua
7. Si el contexto menciona un proyecto, sheet, o repo — asume que es el mismo → "PASS"

REGLA CRÍTICA — DETECCIÓN DE TAREAS COMPLEJAS:
8. Si la tarea implica MÁS DE 5 archivos, MÁS DE 10 tool calls, o operaciones batch (migrar, mover, copiar muchos archivos) → NO digas PASS. En su lugar, sugiere dividir la tarea en bloques de máximo 5 items por mensaje.
   Ejemplo: "Esta tarea involucra ~23 archivos. Sugiero dividir en bloques:
   1. Primero los 6 archivos de agent-controller
   2. Luego los 15 de cuatro-flor/research
   3. Finalmente cmll y reddit-scraper (1 cada uno)
   ¿Con cuál empezamos?"
9. Si el usuario dice "migra todo", "haz todos", "procede con todos" → SIEMPRE sugiere dividir. Jarvis tiene un máximo de 35 rounds por tarea — cada archivo que lee+escribe consume 2 rounds. Más de 10 archivos en un mensaje FALLARÁ.

CONTEXTO DEL SISTEMA:
- Jarvis Knowledge Base: jarvis_file_read/write/list (directives/, NorthStar/, projects/, knowledge/, logs/)
- Proyecto CuatroFlor: /root/claude/cuatro-flor/ → EurekaMD-net/cuatro-flor
- Git: git_commit y git_push REQUIEREN cwd= (directorio del proyecto)
- GitHub org: EurekaMD-net (default para repos nuevos)
- Intel Depot: 8 fuentes (mercados, clima, geopolítica, cyber, noticias)
- Google Sheets: gsheets_read (NO fetch desde browser por CORS)
- LÍMITES: 35 rounds/tarea, 50K tokens. Cada file read+write = 2 rounds. Max ~5 archivos por mensaje.

RESPONDE SOLO con:
- "PASS" (en caso de duda, di PASS — es mejor ejecutar que preguntar de más)
- EXACTAMENTE 2 preguntas numeradas si la ambigüedad causaría un error grave
- Plan de división si la tarea es batch (>5 archivos)
En el 80% de los casos la respuesta correcta es "PASS".`;

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
        max_tokens: 100,
      }),
      deadline,
    ]);

    const raw = (result.content ?? "PASS").trim();
    // Mechanical guard: if LLM returned questions, cap at 2
    if (raw.toUpperCase() === "PASS") return "PASS";
    const lines = raw.split("\n").filter((l) => /^\d+[\.\)]/.test(l.trim()));
    if (lines.length > 2) {
      return lines.slice(0, 2).join("\n");
    }
    return raw;
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
